/**
 * Browser-level test of resumable streams — the owner's exact scenario:
 * send a message, LEAVE the chat mid-reply (click New chat), come back via
 * the sidebar, and the reply must be VISIBLY STREAMING again (content grows
 * live), finish normally, and show exactly one assistant bubble — including
 * after a full page reload. Also covers refresh-mid-stream re-attach.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-stream-resume-ui.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "resume-ui-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `resume-ui-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
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

    const assistantText = () =>
      page.evaluate(() => {
        const bubbles = document.querySelectorAll("[data-role='assistant']");
        const last = bubbles[bubbles.length - 1];
        return last ? (last as HTMLElement).innerText : "";
      });
    const assistantCount = () =>
      page.evaluate(() => document.querySelectorAll("[data-role='assistant']").length);

    // ---- send a slow reply, leave mid-stream --------------------------------
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    const ta = page.locator("textarea");
    await ta.fill("Write the numbers 1 to 60, one per line, each followed by a different three-word phrase. No preamble.");
    await ta.press("Enter");

    // Wait until real text is flowing, then capture the conversation id.
    await page.waitForFunction(
      () => {
        const b = document.querySelectorAll("[data-role='assistant']");
        return b.length > 0 && (b[b.length - 1] as HTMLElement).innerText.length > 40;
      },
      undefined,
      { timeout: 60_000 },
    );
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);
    check("reply is streaming and URL has the conversation id", !!convId, String(convId));
    const seenBeforeLeave = (await assistantText()).length;

    // LEAVE: click "New chat" while the reply is still generating.
    await page.getByRole("link", { name: /new chat/i }).first().click().catch(async () => {
      await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    });
    await page.waitForTimeout(400);
    check("left the chat mid-reply (composer is empty page)", page.url().endsWith("/chat"), page.url());

    // ---- come back: the reply must be streaming again -----------------------
    await page.goto(`${BASE}/chat/${convId}`, { waitUntil: "domcontentloaded" });
    // The resume attach happens right after load — the assistant bubble
    // reappears, the buffered replay pours in (paced wash-in), and content
    // must keep GROWING while the server generates. Wait for the replay to
    // reach what we'd already seen, not just for the empty placeholder node.
    const floor = Math.min(seenBeforeLeave, 40);
    await page
      .waitForFunction(
        (min) => {
          const b = document.querySelectorAll("[data-role='assistant']");
          return b.length > 0 && (b[b.length - 1] as HTMLElement).innerText.length >= min;
        },
        floor,
        { timeout: 15_000 },
      )
      .catch(() => {});
    const len1 = (await assistantText()).length;
    check("resumed bubble replayed at least what was seen before leaving", len1 >= floor, `${len1} vs ${seenBeforeLeave} before`);
    await page.waitForTimeout(2_500);
    const len2 = (await assistantText()).length;
    check("content is GROWING after re-entry (live stream, not a stale load)", len2 > len1, `${len1} → ${len2}`);

    // ---- refresh mid-stream: re-attaches again -------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-role='assistant']").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const len3 = (await assistantText()).length;
    await page.waitForTimeout(2_500);
    const len4 = (await assistantText()).length;
    check("after a mid-stream REFRESH the reply keeps streaming", len4 > len3 || /60/.test(await assistantText()), `${len3} → ${len4}`);

    // ---- completion: one bubble, persisted, no dupes -------------------------
    await page.waitForFunction(
      () => {
        const b = document.querySelectorAll("[data-role='assistant']");
        const t = b.length ? (b[b.length - 1] as HTMLElement).innerText : "";
        return /60/.test(t);
      },
      undefined,
      { timeout: 180_000 },
    );
    check("reply ran to completion (reached 60)", true);
    await page.waitForTimeout(1_500);
    check("exactly ONE assistant bubble after resume+refresh", (await assistantCount()) === 1, `${await assistantCount()} bubbles`);

    // Reload after completion — saved reply renders once, no leftover stream.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
    check("after final reload still exactly one assistant reply", (await assistantCount()) === 1, `${await assistantCount()} bubbles`);
    const finalText = await assistantText();
    check("saved reply is the complete text", /60/.test(finalText), `${finalText.length} chars`);

    const rows = await db.message.findMany({ where: { conversationId: convId! }, orderBy: { createdAt: "asc" } });
    check("DB has exactly user + ONE assistant row", rows.map((r) => r.role).join(",") === "user,assistant", rows.map((r) => r.role).join(","));
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
    await db.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL STREAM-RESUME-UI CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
