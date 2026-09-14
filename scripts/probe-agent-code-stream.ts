/**
 * Probe — does the agent's code preview stream, or land in one burst?
 * (owner report, 2026-09-02: "the code appears all in one go")
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/probe-agent-code-stream.ts
 *
 * One small Sandbox job: write ONE ~80-line HTML file with the Write tool.
 * Measures the same block at three points and prints all three so the
 * burst can be placed:
 *   browser — a MutationObserver planted before the turn records every
 *             change of the live preview's length WITH a timestamp; the
 *             empty block appearing is NOT counted as an update
 *   server  — the chat route's "run_code timing" dev.log line: when the
 *             first/last deltas reached the app, relative to the block start
 * A live stream shows deltas spread over the seconds the model spends
 * writing; a buffered one shows a long silence then all deltas within ~100ms.
 * Diagnostic, not pass/fail — read the numbers.
 */
import { statSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
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
const PASSWORD = "probe-code-stream-1!";
const TASK =
  "Use the Sandbox. Using your Write tool (not a shell heredoc), create ONE file card.html of about 80 lines: a self-contained HTML page with an inline <style> block of at least 40 CSS rules and a body with a heading, three paragraphs of placeholder text and a footer. Do not run anything, do not present anything, just write the file and reply 'done'.";

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

const OBSERVER = `(() => {
  window.__oi = { blocks: {} };
  const sample = () => {
    document.querySelectorAll('[data-run]').forEach((el) => {
      const id = el.getAttribute('data-run');
      const phase = el.getAttribute('data-run-phase');
      const b = (window.__oi.blocks[id] = window.__oi.blocks[id] || { appeared: Date.now(), phases: [], growth: [] });
      if (b.phases[b.phases.length - 1] !== phase) b.phases.push(phase);
      if (phase === 'code') {
        const pre = el.querySelector('pre, code, [data-code]');
        const len = (pre ? pre.textContent : el.textContent || '').length;
        const last = b.growth[b.growth.length - 1];
        if (!last || last.len !== len) b.growth.push({ len, t: Date.now() });
      }
    });
  };
  new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(sample, 50);
})()`;

async function main() {
  const user = await db.user.create({
    data: { email: `probe-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const logSize = statSync("logs/dev.log").size;
  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(OBSERVER);
    const t0 = Date.now();
    await page.locator("textarea").fill(TASK);
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(
      `(() => { const b = [...document.querySelectorAll("[data-role='assistant']")].pop(); return !!b && !!b.querySelector("[aria-label='Retry']"); })()`,
      undefined,
      { timeout: 8 * 60_000 },
    );
    console.log(`turn took ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    convId = (await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }))?.id ?? null;

    const blocks = (await page.evaluate("window.__oi.blocks")) as Record<string, { appeared: number; phases: string[]; growth: { len: number; t: number }[] }>;
    console.log("BROWSER (per run block; times relative to the block appearing):");
    for (const [id, b] of Object.entries(blocks)) {
      const g = b.growth.filter((x) => x.len > 0);
      const rel = (t: number) => `+${((t - b.appeared) / 1000).toFixed(2)}s`;
      console.log(`  ${id.slice(0, 12)}  phases ${b.phases.join("→")}`);
      if (g.length === 0) {
        console.log("    no non-empty preview sampled in the code phase");
      } else {
        console.log(`    ${g.length} content updates; first ${rel(g[0].t)} (${g[0].len} chars) … last ${rel(g[g.length - 1].t)} (${g[g.length - 1].len} chars); span ${((g[g.length - 1].t - g[0].t) / 1000).toFixed(2)}s`);
        console.log(`    timeline: ${g.slice(0, 14).map((x) => `${rel(x.t)}:${x.len}`).join("  ")}${g.length > 14 ? "  …" : ""}`);
      }
    }

    // server side — the chat route's timing line(s), from the log written since we started
    const buf = readFileSync("logs/dev.log");
    const fresh = buf.subarray(logSize).toString("utf8");
    const lines = fresh.split("\n").filter((l) => l.includes("run_code timing") && convId && l.includes(convId));
    console.log("\nSERVER (chat route: when the deltas reached the app):");
    if (lines.length === 0) console.log("  no timing line found (route not reloaded yet? conversation mismatch?)");
    for (const l of lines) {
      const m = l.match(/\{.*\}$/);
      if (!m) continue;
      const j = JSON.parse(m[0]) as Record<string, unknown>;
      console.log(`  ${String(j.id).slice(0, 12)}  ${j.tool} ${j.file ?? ""}: ${j.deltas} deltas / ${j.bytes} bytes; first delta ${j.msToFirstDelta}ms after start; first→last ${j.msFirstToLast}ms; start→${j.phase} ${j.msStartToEnd}ms`);
    }
    console.log("\nREAD IT: live = deltas spread across the seconds the model writes (first→last ≈ start→end);");
    console.log("         buffered upstream = long silence, then first→last of a few ms right before the end.");
  } finally {
    await browser.close();
    if (convId) {
      destroyAgentContainer(convId);
      await deleteChatPool(convId).catch(() => {});
    }
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
