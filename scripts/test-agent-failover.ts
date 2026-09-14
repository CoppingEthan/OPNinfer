/**
 * Live harness — subscription failure → alert + failover to the org API key
 * (owner ask, 2026-09-02). Run:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-failover.ts
 *
 * FORCES a signed-out state by moving the sign-in out of the agent credential
 * volume (restored in finally, always), then runs one Sandbox job in
 * subscription mode with the stored Anthropic key set as the fallback.
 * One real API run (~$0.05–0.15). Proves:
 *   1. the failure is logged at ERROR level with the alert-worthy message
 *      (this is exactly what Admin → SMTP's error alerts email)
 *   2. the chat shows the switch-over status line
 *   3. the job still completes and presents its file
 *   4. the run was billed to the API key (billing_source=api, real cost),
 *      not recorded as a subscription row
 *   5. the sign-in is back afterwards (the harness left no damage)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
const PASSWORD = "agent-failover-1!";
const SETTING_KEY = "capability_sandbox_agent";
const VOLUME = "opninfer-agent-config-default";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
  if (!ok) failures++;
}

/** Run a shell command inside a throwaway container mounting the volume. */
function inVolume(cmd: string): string {
  return execSync(
    `docker run --rm -v ${VOLUME}:/v alpine sh -c "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
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
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
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
    console.error("No stored Anthropic credential — seed one first.");
    process.exit(1);
  }
  const signedIn = inVolume("test -s /v/.credentials.json && echo yes || echo no") === "yes";
  if (!signedIn) {
    console.error("The agent volume has no sign-in to remove — sign in first (see docs/V04_AGENT_TIER.md §4).");
    process.exit(1);
  }

  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  await db.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: {} }, update: {} });
  await db.setting.update({
    where: { key: SETTING_KEY },
    data: {
      value: {
        enabled: true,
        config: {
          credential: "subscription",
          credentialId: anthropic.id, // the fallback
          model: "claude-sonnet-5",
          effort: "medium",
          maxTurns: 20,
          maxMinutes: 5,
          maxBudgetUsd: 2,
          steering: "",
        },
      },
    },
  });
  const user = await db.user.create({
    data: {
      email: `agent-failover-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });
  const since = new Date();

  // --- FORCE the signed-out state ------------------------------------------
  inVolume("mv /v/.credentials.json /v/.credentials.json.harness-bak");
  check("sign-in removed from the volume (the fault we are testing)", inVolume("test -e /v/.credentials.json && echo present || echo gone") === "gone");

  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);

    const t1 = Date.now();
    await sendAndWait(page, "Use the Sandbox to create a file called failover.txt containing exactly this one line: switched — then present the file to me.", 1);
    console.log(`  (turn took ${((Date.now() - t1) / 1000).toFixed(0)}s)`);

    const convo = await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    convId = convo?.id ?? null;

    // 1. the alert-worthy error was logged
    const errs = await db.appLog.findMany({ where: { level: "error", category: "agent", createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
    check("an ERROR-level log entry was written (what the alert email watches)", errs.some((e) => /signed out/i.test(e.message)), errs.map((e) => e.message).join(" | ") || "none");

    // 2. the chat showed the switch-over
    const labels = await page.locator('[data-activity="status"]').allInnerTexts();
    check("the chat shows the switch to the organisation's API key", labels.some((l) => /switching to the organisation's API key/i.test(l)), labels.join(" | "));

    // 3. the job completed anyway
    const cards = await Promise.all((await page.locator(CARD_NAME).all()).map((e) => e.getAttribute("data-file-card").then((v) => v ?? "")));
    check("the job still completed — failover.txt presented", cards.some((c) => /failover\.txt/i.test(c)), cards.join(", "));
    const onDisk = convId ? join(chatPoolDir(convId), "failover.txt") : "";
    check("…and the file is on disk", !!onDisk && existsSync(onDisk) && /switched/.test(readFileSync(onDisk, "utf8")));

    // 4. billed to the API key, not the (absent) subscription
    const rows = await db.usageRecord.findMany({ where: { userId: user.id, role: "agent" } });
    check("agent usage was billed to the API key (billing_source=api, real cost)", rows.length > 0 && rows.every((r) => r.billingSource === "api") && rows.reduce((s, r) => s + Number(r.costEstimate), 0) > 0, rows.map((r) => `${r.billingSource} $${r.costEstimate}`).join(" | "));
    check("no subscription-billed rows were recorded", !rows.some((r) => r.billingSource === "subscription"));
  } finally {
    await browser.close();
    // ALWAYS put the sign-in back.
    inVolume("test -e /v/.credentials.json.harness-bak && mv /v/.credentials.json.harness-bak /v/.credentials.json || true");
    check("the sign-in is restored in the volume", inVolume("test -s /v/.credentials.json && echo yes || echo no") === "yes");
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
  // Best effort: never leave the operator signed out because a harness threw.
  try {
    inVolume("test -e /v/.credentials.json.harness-bak && mv /v/.credentials.json.harness-bak /v/.credentials.json || true");
  } catch {
    /* nothing more to do */
  }
  process.exit(1);
});
