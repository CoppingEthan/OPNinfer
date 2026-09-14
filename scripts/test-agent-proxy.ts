/**
 * Live harness — Stage 6: the org-API-key path through the credential proxy.
 * Run:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-proxy.ts
 *
 * One short Sandbox job in API mode = real (small) API spend. Proves:
 *   1. the agent container is pointed at the PROXY, not Anthropic, and the
 *      org key is NOT in its environment (read from the spawn's dev.log line)
 *   2. the job still completes: delegation, file presented, on disk
 *   3. usage was METERED BY THE PROXY from Anthropic's real numbers — rows
 *      under role=agent with a non-zero cost (the tool emits none in API
 *      mode, so any agent row is the proxy's)
 *   4. the proxy refuses a bogus bearer and an unlisted path
 *
 * Snapshot-restores settings; removes its user, pool, state and container.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolDir, deleteChatPool } from "../src/lib/storage";
import { destroyAgentContainer } from "../src/lib/agent/spawn";

try {
  process.loadEnvFile(".env");
} catch {
  /* env already present */
}

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "agent-proxy-1!";
const SETTING_KEY = "capability_sandbox_agent";
const DEV_LOG = join(process.cwd(), "logs", "dev.log");

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

const CARD_NAME = "[data-role='assistant'] [data-file-card]";

async function sendAndWait(page: Page, text: string, expectAssistants: number, timeout = 300_000) {
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
  const anthropic = await db.providerCredential.findFirst({ where: { provider: "anthropic_api" }, orderBy: { createdAt: "asc" } });
  if (!anthropic) {
    console.error("No stored Anthropic credential — seed one first (scripts/seed-keys.ts).");
    process.exit(1);
  }

  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });

  const user = await db.user.create({
    data: {
      email: `agent-proxy-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  // --- 4. the proxy's front door, before any run -----------------------------
  const bogus = await fetch(`${BASE}/api/agent-proxy/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
  });
  check("proxy refuses a bogus bearer with 401", bogus.status === 401, `status ${bogus.status}`);
  const unlisted = await fetch(`${BASE}/api/agent-proxy/v1/models`, { method: "POST", headers: { authorization: "Bearer x" } });
  check("proxy refuses an unlisted path with 404", unlisted.status === 404, `status ${unlisted.status}`);
  const noAuth = await fetch(`${BASE}/api/agent-proxy/v1/messages`, { method: "POST", body: "{}" });
  check("proxy refuses a missing bearer (not a session redirect)", noAuth.status === 401, `status ${noAuth.status}`);

  // Byte offset, not string offset: dev.log is UTF-8 with multi-byte glyphs.
  const logStart = existsSync(DEV_LOG) ? statSync(DEV_LOG).size : 0;

  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);

    const t1 = Date.now();
    await sendAndWait(
      page,
      "Use the Sandbox to create a file called hello.txt containing exactly this one line: proxied — then present the file to me.",
      1,
    );
    console.log(`  (turn took ${((Date.now() - t1) / 1000).toFixed(0)}s)`);

    const convo = await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    convId = convo?.id ?? null;
    check("conversation exists", !!convo);

    const cards = await Promise.all((await page.locator(CARD_NAME).all()).map((e) => e.getAttribute("data-file-card").then((v) => v ?? "")));
    check("hello.txt was presented", cards.some((c) => /hello\.txt/i.test(c)), cards.join(", "));
    const onDisk = convId ? join(chatPoolDir(convId), "hello.txt") : "";
    check(
      "the file is in the pool with the right content",
      !!onDisk && existsSync(onDisk) && /proxied/.test(readFileSync(onDisk, "utf8")),
      onDisk && existsSync(onDisk) ? readFileSync(onDisk, "utf8").trim() : "missing",
    );

    // --- 1. the container never saw the key ----------------------------------
    const logTail = readFileSync(DEV_LOG).subarray(logStart).toString("utf8");
    const spawnLine = logTail
      .split("\n")
      .filter((l) => l.includes("[agent] spawn (") && convId && l.includes(convId))
      .pop();
    check("found the run's spawn line in dev.log", !!spawnLine, spawnLine ? "yes" : "no spawn line for this chat");
    if (spawnLine) {
      const keys = (() => {
        try {
          const j = JSON.parse(spawnLine.slice(spawnLine.indexOf("{")));
          return (j.envKeys as string[]) ?? [];
        } catch {
          return [];
        }
      })();
      check("container env points at the PROXY (ANTHROPIC_BASE_URL + per-run bearer)", keys.includes("ANTHROPIC_BASE_URL") && keys.includes("ANTHROPIC_AUTH_TOKEN"), keys.join(","));
      check("container env has NO ANTHROPIC_API_KEY", !keys.includes("ANTHROPIC_API_KEY"), keys.join(","));
    }

    // --- 3. metered by the proxy ----------------------------------------------
    const rows = await db.usageRecord.findMany({ where: { userId: user.id, role: "agent" } });
    check("usage rows under role=agent were recorded", rows.length >= 1, `${rows.length} rows`);
    const totalCost = rows.reduce((s, r) => s + Number(r.costEstimate), 0);
    check("…with a non-zero cost from Anthropic's real numbers (the tool emits none in API mode)", totalCost > 0, `$${totalCost.toFixed(4)} over ${rows.length} calls`);
    check("…with real input tokens", rows.some((r) => r.inputTokens + r.cacheReadTokens > 0), rows.map((r) => `${r.model}: in=${r.inputTokens} cr=${r.cacheReadTokens} out=${r.outputTokens}`).join(" | "));
    const metered = logTail.split("\n").filter((l) => l.includes("proxy: call metered")).length;
    check("the proxy logged each metered call", metered >= 1, `${metered} calls`);
    check(
      "API-key rows are billed for real (billing_source=api, no notional value)",
      rows.every((r) => r.billingSource === "api" && r.notionalCost === null),
      rows.map((r) => `${r.billingSource} notional=${r.notionalCost}`).join(" | "),
    );
  } finally {
    await browser.close();
    if (prior) await db.setting.update({ where: { key: SETTING_KEY }, data: { value: prior.value as object } });
    else await db.setting.deleteMany({ where: { key: SETTING_KEY } });
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
