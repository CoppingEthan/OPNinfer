/**
 * Live harness — a Sandbox run that lasts LONGER THAN FIVE MINUTES survives.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-sandbox-long-run.ts
 *
 * Needs `pnpm dev` (or TEST_BASE_URL), the dev broker, the opninfer-agent
 * image and a working agent sign-in. One agent run on the subscription,
 * about seven minutes of wall clock, almost all of it a `sleep`.
 *
 * Why it exists (2026-09-10): a run is ONE HTTP request to the broker held
 * open for its whole life, and Node's http server closes any request still
 * incomplete after five minutes by default (`requestTimeout`). Every run
 * longer than that was cut off at 5:00–5:30, mid-command — the running
 * command got SIGKILL (exit 137), the container was torn down, the model
 * was told the run "did not complete" and usually tried again — and nothing
 * was logged. Verified to FAIL on the pre-fix broker: the run dies at ~5m10s,
 * the reply carries a "run ended before this step finished" block, and the
 * new WARN row lands instead of the finished line.
 *
 * Proves, on a fixed broker:
 *   1. a single command that sleeps six minutes completes and its output
 *      reaches the reply
 *   2. no run block was left "ended before this step finished"
 *   3. exactly ONE agent run was billed (no retry after a cut-off)
 *   4. the turn genuinely spanned the five-minute mark
 *   5. no "Sandbox run did not complete" warning was logged
 *
 * Snapshot-restores the Sandbox capability setting and removes its own user,
 * chat pool, agent state and container.
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { deleteChatPool } from "../src/lib/storage";
import { destroyAgentContainer } from "../src/lib/agent/spawn";

try {
  process.loadEnvFile(".env");
} catch {
  /* env already present */
}

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "sandbox-long-1!";
const SETTING_KEY = "capability_sandbox_agent";
const SLEEP_SECONDS = 360;
const MARKER = "finished-after-the-long-sleep";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
  if (!ok) failures++;
}

async function signIn(email: string) {
  const jar = new Map<string, string>();
  const store = (cs: string[]) => {
    for (const c of cs) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
  store(r1.headers.getSetCookie());
  const { csrfToken } = (await r1.json()) as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

/** Send and wait for the reply to fully finish (Retry on the last bubble, no live run block). */
async function sendAndWait(page: Page, text: string, expectAssistants: number, timeout: number) {
  const ta = page.locator("textarea");
  await ta.fill(text);
  await ta.press("Enter");
  await page.waitForFunction(
    `(() => {
      const bubbles = document.querySelectorAll("[data-role='assistant']");
      if (bubbles.length < ${expectAssistants}) return false;
      const last = bubbles[bubbles.length - 1];
      const live = document.querySelector('[data-run-phase="code"], [data-run-phase="exec"]');
      return !live && !!last.querySelector("[aria-label='Retry']");
    })()`,
    undefined,
    { timeout },
  );
}

async function main() {
  const stamp = Date.now();
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  await db.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: {} }, update: {} });
  await db.setting.update({
    where: { key: SETTING_KEY },
    data: {
      value: {
        enabled: true,
        config: {
          credential: "subscription",
          model: "claude-sonnet-5",
          effort: "low",
          maxTurns: 30,
          // Ten minutes: the admin's budget must not be what ends this run.
          maxMinutes: 10,
          maxBudgetUsd: 5,
          steering: "",
        },
      },
    },
  });

  const user = await db.user.create({
    data: {
      email: `sandbox-long-${stamp}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);

    const t0 = Date.now();
    let finished = true;
    try {
      await sendAndWait(
        page,
        `Use the Sandbox for this, as ONE run. In it, run exactly this single shell command — give the command a timeout of 540000 ms so it is not cut short — and then tell me the exact line it printed:\n\nsleep ${SLEEP_SECONDS}; echo ${MARKER}`,
        1,
        (SLEEP_SECONDS + 240) * 1000,
      );
    } catch {
      finished = false;
    }
    const turnSecs = (Date.now() - t0) / 1000;
    check("the turn finished", finished, `${turnSecs.toFixed(0)}s`);

    convId = (await db.conversation.findFirst({ where: { userId: user.id }, select: { id: true } }))?.id ?? null;
    check("conversation exists", !!convId);
    const reply = convId
      ? await db.message.findFirst({ where: { conversationId: convId, role: "assistant" }, orderBy: { createdAt: "desc" } })
      : null;
    const meta = (reply?.meta ?? {}) as { toolRuns?: Array<{ error?: string; output?: string }> };
    const runs = meta.toolRuns ?? [];
    const dangling = runs.filter((r) => /run ended before this step finished/i.test(r.error ?? ""));
    check("no run block ended before its step finished", runs.length > 0 && dangling.length === 0, `${runs.length} run blocks, ${dangling.length} cut off`);
    const printed = runs.some((r) => (r.output ?? "").includes(MARKER));
    check("the six-minute command ran to completion (its output is in a run block)", printed);
    check("the reply relays the command's output", (reply?.content ?? "").includes(MARKER), (reply?.content ?? "").slice(0, 160));

    const agentRows = await db.usageRecord.count({ where: { userId: user.id, role: "agent" } });
    check("exactly one agent run was billed (no retry after a cut-off)", agentRows === 1, `${agentRows} rows`);
    check("the run genuinely spanned the five-minute mark", turnSecs > 330, `${turnSecs.toFixed(0)}s`);

    const warns = await db.appLog.findMany({
      where: { category: "agent", message: "Sandbox run did not complete", createdAt: { gte: new Date(t0) } },
      orderBy: { createdAt: "asc" },
    });
    const mine = warns.filter((w) => JSON.stringify(w.details ?? {}).includes(convId ?? "∅"));
    check("no 'Sandbox run did not complete' warning was logged", mine.length === 0, mine.map((w) => JSON.stringify(w.details).slice(0, 200)).join(" | "));
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    if (prior) {
      await db.setting.update({ where: { key: SETTING_KEY }, data: { value: prior.value as object } });
    } else {
      await db.setting.deleteMany({ where: { key: SETTING_KEY } });
    }
    if (convId) {
      destroyAgentContainer(convId);
      await deleteChatPool(convId).catch(() => {});
    }
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
