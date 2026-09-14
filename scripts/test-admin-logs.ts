/**
 * Browser-level test of the Admin → Logs revamp (owner ask, 2026-07-19,
 * checklist 13.9): two views over the live log — "Chats" (per-reply feed:
 * user, when, model, in/cached/out tokens, cost, duration, tool count) and
 * "Raw" (every event; click to expand the full details JSON).
 *
 *  1. Send a cheap chat turn as an admin user.
 *  2. /admin/logs → Chats view lists that reply with user + real numbers.
 *  3. Raw view shows the event; clicking it expands the details JSON.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-admin-logs.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "logs-test-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const email = `logs-admin-${Date.now()}@example.test`;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: new URLSearchParams({ csrfToken, email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();

    // 1. A cheap turn so a fresh enriched chat log row exists.
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    const ta = page.locator("textarea");
    await ta.fill("Reply with exactly the word: pong");
    await ta.press("Enter");
    await page.waitForFunction(
      `(() => {
        const b = document.querySelectorAll("[data-role='assistant']");
        const last = b[b.length - 1];
        return !!last && !!last.querySelector("[aria-label='Retry']");
      })()`,
      undefined,
      { timeout: 180_000 },
    );
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);

    // 2. Chats view (default): our reply row with user + numbers.
    // NB: the page holds the log SSE open — networkidle never fires here.
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`[browser error] ${msg.text().slice(0, 400)}`);
    });
    page.on("pageerror", (err) => console.log(`[page error] ${String(err).slice(0, 400)}`));
    await page.goto(`${BASE}/admin/logs`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("table", { timeout: 30_000 });
    const chatsTable = page.locator("table").first();
    const header = await chatsTable.locator("thead").innerText();
    check(
      "Chats view is the default with token/cost columns",
      /user/i.test(header) && /cached/i.test(header) && /cost/i.test(header) && /tools/i.test(header),
      header.replace(/\s+/g, " "),
    );
    const firstRow = await chatsTable.locator("tbody tr").first().innerText();
    check("newest chat row shows this user", firstRow.includes(email.split("@")[0]) || firstRow.includes(email), firstRow);
    check("row carries a model id", /(claude|gpt|gemini)/i.test(firstRow), firstRow);
    check("row carries real token numbers + cost + duration", /\$\d/.test(firstRow) && /\d+(\.\d+)?s/.test(firstRow), firstRow);

    // 3. Raw view: full events, click-to-expand details JSON.
    // Click-until-active: the FIRST trusted click right after page load can
    // be swallowed by the hydration race (verified: 2nd+ clicks always work).
    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: "Raw" }).click();
      await page.waitForTimeout(400);
      const cur = await page.evaluate(`document.querySelector("button[aria-current]")?.textContent ?? ""`);
      if (cur === "Raw") break;
    }
    await page.waitForFunction(
      `/level/i.test(document.querySelector("table thead")?.innerText ?? "")`,
      undefined,
      { timeout: 10_000 },
    );
    const rawHeader = await page.locator("table thead").first().innerText();
    check(
      "Raw view keeps level/category columns + user",
      /level/i.test(rawHeader) && /category/i.test(rawHeader) && /user/i.test(rawHeader),
      rawHeader.replace(/\s+/g, " "),
    );
    const rawDump = await page.locator("table tbody").first().innerText();
    const rawRow = page.locator("tbody tr", { hasText: "Assistant reply" }).first();
    const rowVisible = await rawRow.isVisible().catch(() => false);
    check("Raw view lists the Assistant reply event", rowVisible, rawDump.slice(0, 200));
    if (rowVisible) {
      await rawRow.click();
      const detailsPre = page.locator("pre").first();
      await detailsPre.waitFor({ timeout: 5_000 });
      const json = await detailsPre.innerText();
      check(
        "Raw row expands to the full details JSON (tokens/duration present)",
        json.includes("outputTokens") && json.includes("durationMs") && json.includes("conversationId"),
        json.slice(0, 140),
      );
    } else {
      check("Raw row expands to the full details JSON (tokens/duration present)", false, "row not found");
    }
  } finally {
    await browser.close();
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
    await db.appLog.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
