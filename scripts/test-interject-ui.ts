/**
 * Browser-level test of mid-turn steering EXACTLY as the owner does it:
 * type the task, press Enter, wait for "Running:" to appear, type the
 * correction, press Enter again. Asserts the composer button is SEND (not
 * Stop) while text is typed mid-stream (clicking must never kill the reply),
 * the chip flips to "Steering the task:", the interjected bubble lands above
 * the streaming reply, and ONE final answer honors the correction.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-interject-ui.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "interject-ui-1!";
const MAGIC = "PENGUIN-99";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `interject-ui-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    // Capture what the PAGE's interject fetch actually received.
    let interjectResponse: string | null = null;
    page.on("response", (res) => {
      if (res.url().includes("/api/chat/queue")) {
        void res.text().then((t) => {
          interjectResponse = `${res.status()} ${t}`;
          console.log(`  [net] interject → ${interjectResponse}`);
        }).catch(() => {});
      }
    });

    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    const ta = page.locator("textarea");
    await ta.fill(
      "Use the sandbox to run `sleep 18 && echo first-step-done`, then after it returns run `sleep 18 && echo second-step-done` as a separate command — strictly one at a time. Then briefly report both outputs.",
    );
    await ta.press("Enter");

    // Wait until the task is really running (a tool status line is on screen).
    // The agent tier's run blocks: a `[data-run]` block appears the moment the
    // agent starts writing its first command (the exec phase itself can be
    // over in one batch, so the old "Running…" text is not a reliable signal).
    try {
      await page.locator("[data-run]").first().waitFor({ state: "visible", timeout: 90_000 });
      check("task running (run block visible)", true);
    } catch (e) {
      await page.screenshot({ path: "logs/interject-ui-first.png", fullPage: true }).catch(() => {});
      const body = await page.locator("body").innerText().catch(() => "");
      check("task running (run block visible)", false, `no run block seen — body: ${body.slice(0, 400)}`);
      throw e;
    }
    check("button is STOP while streaming with empty input", await page.getByLabel("Stop").isVisible());

    // Type the correction mid-run — the button must become SEND, not Stop.
    await ta.fill(`also end your reply with the exact word ${MAGIC}`);
    check("button flips to SEND once text is typed mid-stream", await page.getByLabel("Send").isVisible() && !(await page.getByLabel("Stop").isVisible()));
    // Submit via the BUTTON (the exact click that used to stop the chat).
    await page.getByLabel("Send").click();
    // v0.5: the message goes to the SERVER-HELD queue (POST /api/chat/queue),
    // which offers it to the running turn as a steer; the chip the live feed
    // hands back says which path it took.
    await page.locator("[data-queued]").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    check("queued chip rendered after mid-stream submit", await page.locator("[data-queued]").first().isVisible());
    try {
      await page.locator('[data-queued][data-queued-steering="1"]').first().waitFor({ state: "visible", timeout: 15_000 });
      check("chip shows 'Steering the task:'", await page.getByText("Steering the task", { exact: false }).first().isVisible());
    } catch {
      await page.screenshot({ path: "logs/interject-ui-fail.png", fullPage: true });
      check("chip shows 'Steering the task:'", false, `queue response: ${interjectResponse ?? "(none seen)"} — screenshot logs/interject-ui-fail.png`);
    }

    // The interjected bubble must appear ABOVE the streaming reply.
    await page.getByText(`also end your reply with the exact word ${MAGIC}`, { exact: false }).nth(0).waitFor({ state: "visible", timeout: 60_000 });
    check("interjected user bubble rendered", true);

    // One single answer that honors the correction.
    await page.getByText(MAGIC).nth(1).waitFor({ state: "visible", timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);
    check("conversation id resolved from URL", !!convId, String(convId));
    if (convId) {
      // Give the reply save a moment, then assert the transcript shape.
      let rows: { role: string; content: string }[] = [];
      for (let i = 0; i < 30; i++) {
        rows = await db.message.findMany({ where: { conversationId: convId }, orderBy: { createdAt: "asc" } });
        if (rows.length >= 3 && rows[rows.length - 1].role === "assistant") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const roles = rows.map((r) => r.role).join(",");
      check("transcript is user → interjection → ONE reply", roles === "user,user,assistant", roles);
      check("the single reply honors the correction", rows[2]?.content.includes(MAGIC) === true, rows[2]?.content.slice(-120));
      check("reply also reports the task output", /first-step-done/.test(rows[2]?.content ?? ""));
    }
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
    await db.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL INTERJECT-UI CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
