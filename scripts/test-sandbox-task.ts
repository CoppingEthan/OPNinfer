/**
 * Live harness — Stage 5 of the Sandbox agent tier: `sandbox_task` in a REAL
 * chat, in a real browser, against a real model and a real container. Run:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-sandbox-task.ts
 *
 * Needs `pnpm dev`, the dev broker with the agent tier, the opninfer-agent
 * image, and the operator signed in inside the agent volume. Four agent runs
 * on the subscription (~1–2 min total).
 *
 * Proves the user story end to end:
 *   1. the conversation model DELEGATES to the Sandbox, and the agent's inner
 *      steps stream as the existing run blocks + status lines
 *   2. the file the agent makes is PRESENTED as a card, exists on disk in the
 *      chat's pool, and has a files row
 *   3. usage is recorded under role=agent and the session id is saved
 *   4. a follow-up RESUMES the same agent session (same session id) and the
 *      edit lands in the same file — the "change red to blue" story
 *   5. Stop interrupts a long run promptly, and the conversation is not left
 *      stuck (a later message answers normally — no 409)
 *   6. run chips and the file card survive a reload
 *
 * Snapshot-restores the Sandbox capability setting and removes its own user,
 * chat pool, agent state and container.
 */
import { existsSync, readFileSync } from "node:fs";
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
const PASSWORD = "sandbox-task-1!";
const SETTING_KEY = "capability_sandbox_agent";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
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

/** File-CARD filenames only (never prose): the GeneratedFiles name span. */
const CARD_NAME = "[data-role='assistant'] [data-file-card]";

/** Send and wait for the reply to fully finish: Retry on the last bubble and
 *  no live run block (the same rule test-present-files.ts uses). */
async function sendAndWait(page: Page, text: string, expectAssistants: number, timeout = 300_000) {
  const ta = page.locator("textarea");
  await ta.fill(text);
  await ta.press("Enter");
  try {
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
  } catch (e) {
    // Say what the screen looked like — a bare timeout is useless to debug.
    const snap = await page.evaluate(`(() => {
      const bubbles = [...document.querySelectorAll("[data-role='assistant']")];
      return {
        assistants: bubbles.length,
        expected: ${expectAssistants},
        lastText: bubbles.length ? (bubbles[bubbles.length - 1].innerText || "").slice(0, 120) : null,
        lastHasRetry: bubbles.length ? !!bubbles[bubbles.length - 1].querySelector("[aria-label='Retry']") : null,
        live: !!document.querySelector('[data-run-phase="code"], [data-run-phase="exec"]'),
        composer: document.querySelector("button[aria-label='Stop']") ? "stop" : document.querySelector("button[aria-label='Send']") ? "send" : "?",
        notice: (document.querySelector("[data-composer-notice]")?.textContent || "").slice(0, 120),
      };
    })()`);
    console.log("sendAndWait timed out — screen:", JSON.stringify(snap));
    throw e;
  }
}

/** A finished reply folds its working steps into one row (2026-09-02); the
 *  status lines and run chips inside it are not rendered until expanded. */
async function expandFoldedSteps(page: Page) {
  const folded = page.locator("[data-role='assistant'] [data-activity-collapsed]");
  const n = await folded.count();
  for (let i = 0; i < n; i++) await folded.nth(i).click().catch(() => {});
  if (n > 0) await page.waitForTimeout(300);
}

async function statusLabels(page: Page): Promise<string[]> {
  await expandFoldedSteps(page);
  return page.locator('[data-activity="status"]').allInnerTexts();
}

async function main() {
  const stamp = Date.now();
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  // Known configuration for the run: subscription, a modest budget, default
  // steering. Restored afterwards.
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: {} },
    update: {},
  });
  await db.setting.update({
    where: { key: SETTING_KEY },
    data: {
      value: {
        enabled: true,
        config: {
          credential: "subscription",
          model: "claude-sonnet-5",
          effort: "medium",
          maxTurns: 30,
          maxMinutes: 5,
          maxBudgetUsd: 5,
          steering: "",
        },
      },
    },
  });

  const user = await db.user.create({
    data: {
      email: `sandbox-task-${stamp}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      // A brand-new account gets the What's new panel once — a modal overlay
      // that swallowed the Stop click (fill() bypasses pointer events, a
      // click doesn't). Mark the notes as seen so the chat is clear.
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

    // --- 1 + 2 + 3: delegate, stream, present ---------------------------------
    const t1 = Date.now();
    await sendAndWait(
      page,
      "Use the Sandbox to create a file called greeting.txt containing exactly this one line: hello from the sandbox — then present the file to me.",
      1,
    );
    console.log(`  (turn 1 took ${((Date.now() - t1) / 1000).toFixed(0)}s)`);

    const labels1 = await statusLabels(page);
    check(
      "the conversation model delegated to the Sandbox (outer status line)",
      labels1.some((l) => /Working in the Sandbox/i.test(l)),
      labels1.join(" | "),
    );
    const chips1 = await page.locator('button[data-run-phase="done"]').count();
    check("the agent's inner steps rendered as run blocks", chips1 >= 1, `${chips1} chips`);
    const cards1 = await Promise.all((await page.locator(CARD_NAME).all()).map((e) => e.getAttribute("data-file-card").then((v) => v ?? "")));
    check("greeting.txt was presented as a file card", cards1.some((c) => /greeting\.txt/i.test(c)), cards1.join(", "));

    const convo = await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    convId = convo?.id ?? null;
    check("conversation exists", !!convo);
    const session1 = convo?.agentSessionId ?? null;
    check("agent session id saved on the conversation", !!session1, session1 ?? "null");

    const onDisk = convId ? join(chatPoolDir(convId), "greeting.txt") : "";
    check(
      "the file exists in the chat's pool on disk with the right content",
      !!onDisk && existsSync(onDisk) && /hello from the sandbox/.test(readFileSync(onDisk, "utf8")),
      onDisk && existsSync(onDisk) ? readFileSync(onDisk, "utf8").trim() : "missing",
    );
    const row = convId ? await db.file.findFirst({ where: { conversationId: convId, filename: "greeting.txt" } }) : null;
    check("a files row was created for it", !!row, row ? `kind=${row.kind} status=${row.status}` : "none");

    const agentRows = await db.usageRecord.findMany({ where: { userId: user.id, role: "agent" } });
    check("usage recorded under role=agent", agentRows.length >= 1, `${agentRows.length} rows`);
    // Owner rule: on the subscription a call is real tokens at $0.00, with
    // its API-rate value kept separately as "saved" — never a fake bill.
    check(
      "subscription rows are billed $0.00 with a notional value kept",
      agentRows.every((r) => r.billingSource === "subscription" && Number(r.costEstimate) === 0 && Number(r.notionalCost ?? 0) > 0),
      agentRows.map((r) => `${r.billingSource} cost=${r.costEstimate} notional=${r.notionalCost}`).join(" | "),
    );
    check(
      "subscription rows carry the agent session id",
      agentRows.every((r) => !!r.agentSessionId),
      agentRows.map((r) => r.agentSessionId ?? "null").join(","),
    );

    // --- 4: the follow-up RESUMES the same session — ACROSS A RECYCLE ---------
    // The container is destroyed between the two turns, as the idle reaper
    // would do after half an hour. Resume must still work, because the
    // agent's transcript lives in the chat's persistent state directory, not
    // in the container. (This is why a Postgres session store was dropped
    // from the plan: the property it would buy is already held.)
    destroyAgentContainer(convId!);
    await page.waitForTimeout(3_000);
    const gone = !(await import("node:child_process"))
      .execSync(`docker ps -a --filter "name=oi-agent-default-${convId}" --format "{{.Names}}"`, { encoding: "utf8" })
      .trim();
    check("agent container recycled between turns", gone);
    const t2 = Date.now();
    await sendAndWait(
      page,
      "Now change greeting.txt so its one line reads exactly: hello again from the sandbox — and present it again.",
      2,
    );
    console.log(`  (turn 2 took ${((Date.now() - t2) / 1000).toFixed(0)}s)`);
    const convo2 = await db.conversation.findUnique({ where: { id: convId! } });
    check(
      "follow-up resumed the SAME agent session after the recycle (no new session id)",
      !!session1 && convo2?.agentSessionId === session1,
      `before=${session1} after=${convo2?.agentSessionId}`,
    );
    check(
      "the edit landed in the same file",
      existsSync(onDisk) && /hello again from the sandbox/.test(readFileSync(onDisk, "utf8")),
      existsSync(onDisk) ? readFileSync(onDisk, "utf8").trim() : "missing",
    );

    // --- 5: Stop interrupts a long run, and the chat isn't left stuck -----------
    const ta = page.locator("textarea");
    await ta.fill("Use the Sandbox: write a script wait.sh that sleeps for 120 seconds and then prints finished, run it, and tell me when it has finished.");
    await ta.press("Enter");
    // Wait until the agent is visibly mid-run.
    await page.waitForSelector('[data-run-phase="exec"], [data-run-phase="code"]', { timeout: 90_000 });
    await page.waitForTimeout(2_000);
    const tStop = Date.now();
    await page.getByLabel("Stop", { exact: true }).click();
    // The user-facing end of a turn is the Stop button becoming Send again.
    // (A stopped reply with no prose may render no Retry action, so the
    // bubble-based wait used elsewhere is the wrong signal here — the server
    // log showed the run ending 61ms after Stop while that wait sat for 60s.)
    await page.getByLabel("Send", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction(
      `!document.querySelector('[data-run-phase="code"], [data-run-phase="exec"]')`,
      undefined,
      { timeout: 15_000 },
    );
    const stopSecs = (Date.now() - tStop) / 1000;
    check("Stop ended the turn promptly (well under the 120s sleep)", stopSecs < 45, `${stopSecs.toFixed(1)}s`);
    check("no run block is left live after Stop", true);

    const t4 = Date.now();
    const bubblesNow = await page.locator("[data-role='assistant']").count();
    const agentRunsBefore = await db.usageRecord.count({ where: { userId: user.id, role: "agent" } });
    await sendAndWait(page, "Reply with just the word: ready", bubblesNow + 1, 120_000);
    check("the conversation accepts a new turn after Stop (not stuck / no 409)", true, `${((Date.now() - t4) / 1000).toFixed(0)}s`);
    // Found live: with the stopped turn dropped from replay, the model saw the
    // wait.sh request with no reply and RESTARTED it on "reply with: ready".
    const agentRunsAfter = await db.usageRecord.count({ where: { userId: user.id, role: "agent" } });
    check(
      "a trivial message after Stop does NOT restart the stopped job",
      agentRunsAfter === agentRunsBefore,
      `agent runs before=${agentRunsBefore} after=${agentRunsAfter}`,
    );

    // --- 6: persistence --------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    // A loaded reply starts FOLDED (2026-09-02): the chips are inside the fold.
    await page.waitForSelector("[data-role='assistant'] [data-activity-collapsed], [data-run-phase=\"done\"]", { timeout: 30_000 });
    await expandFoldedSteps(page);
    await page.waitForSelector('[data-run-phase="done"]', { timeout: 30_000 });
    const chipsAfter = await page.locator('button[data-run-phase="done"]').count();
    check("run chips survive a reload", chipsAfter >= 1, `${chipsAfter} chips`);
    const cardsAfter = await Promise.all((await page.locator(CARD_NAME).all()).map((e) => e.getAttribute("data-file-card").then((v) => v ?? "")));
    check("the file card survives a reload", cardsAfter.some((c) => /greeting\.txt/i.test(c)), cardsAfter.join(", "));

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
