/**
 * Browser-level test of FILE PRESENTATION (owner feature, 2026-07-19): the
 * conversation pool is the assistant's private workspace — files it creates
 * are NOT shown to the user unless it hands them over via present_files.
 *
 *  1. "write gen.py that creates results.csv, run it, give me ONLY the csv"
 *     → results.csv renders as a download card; gen.py does NOT.
 *  2. "now give me gen.py as well" → gen.py card appears on the NEW reply
 *     (late presentation of an earlier turn's file).
 *  3. "make a bar chart PNG and show it to me" → the PNG renders INLINE via
 *     the generated-image flow (an <img>), not as a grey file card.
 *  4. Reload → presentation persists exactly (meta.fileIds / meta.images);
 *     the masked script count stays masked (no time-fallback resurrection).
 *
 * Requires: dev server on :3000, sandboxd + Docker, a conversation model.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-present-files.ts
 */
import { rm } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolDir } from "../src/lib/storage";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "present-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

/** File-CARD filenames only (never prose): the GeneratedFiles name span. */
const CARD_NAME = "[data-role='assistant'] [data-file-card]";

async function cardNames(page: Page): Promise<string[]> {
  return Promise.all((await page.locator(CARD_NAME).all()).map((e) => e.getAttribute("data-file-card").then((v) => v ?? "")));
}

/** Send a message and wait until the reply fully finishes (Retry action on
 *  the LAST bubble + no live run blocks + expected bubble count). */
async function sendAndWait(page: Page, text: string, expectAssistants: number) {
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
    { timeout: 300_000 },
  );
}

async function main() {
  const user = await db.user.create({
    data: { email: `present-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
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
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });

    // --- Turn 1: deliverable only, script masked -------------------------------
    await sendAndWait(
      page,
      "Using your sandbox: write gen.py that creates results.csv containing 5 rows of made-up sales data (columns: product,units,revenue) and run it. Then hand me ONLY results.csv — I don't need the script.",
      1,
    );
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);

    let cards = await cardNames(page);
    check("results.csv presented as a download card", cards.some((c) => c.trim() === "results.csv"), cards.join(", "));
    check("gen.py is MASKED (no card)", !cards.some((c) => c.includes("gen.py")), cards.join(", "));

    // Persistence-layer masking: the first reply's meta must link ONLY the
    // presented deliverable (never the script — whether the model kept or
    // deleted it, it must not be linked).
    const reply1 = convId
      ? await db.message.findFirst({
          where: { conversationId: convId, role: "assistant" },
          orderBy: { createdAt: "asc" },
        })
      : null;
    const meta1 = reply1?.meta as { fileIds?: string[] } | null;
    const linked1 = meta1?.fileIds ?? [];
    const linkedNames = convId
      ? (await db.file.findMany({ where: { id: { in: linked1 } }, select: { filename: true } })).map((f) => f.filename)
      : [];
    check(
      "reply 1 meta links ONLY the presented deliverable",
      linkedNames.length === 1 && linkedNames[0] === "results.csv",
      linkedNames.join(", ") || "(none)",
    );

    // --- Turn 2: late presentation of the earlier turn's file ------------------
    await sendAndWait(page, "Now give me gen.py as well please.", 2);
    cards = await cardNames(page);
    check("gen.py presented on request (card appears)", cards.some((c) => c.trim() === "gen.py"), cards.join(", "));

    // --- Turn 3: presented image renders INLINE, not as a card -----------------
    await sendAndWait(
      page,
      "Make a small bar chart PNG of those 5 revenues with matplotlib in your sandbox and show me the chart.",
      3,
    );
    const inlineImgs = await page.locator("[data-role='assistant'] img[alt$='.png' i]").count();
    cards = await cardNames(page);
    check("presented PNG renders INLINE (img element)", inlineImgs > 0, `${inlineImgs} inline image(s)`);
    check("presented PNG is NOT a grey file card", !cards.some((c) => c.toLowerCase().endsWith(".png")), cards.join(", "));

    // --- Reload: presentation persists, masking holds --------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='assistant']", { timeout: 30_000 });
    const reloadCards = await cardNames(page);
    const reloadImgs = await page.locator("[data-role='assistant'] img[alt$='.png' i]").count();
    check(
      "reload: exactly the presented cards survive (results.csv + gen.py)",
      reloadCards.some((c) => c.trim() === "results.csv") && reloadCards.some((c) => c.trim() === "gen.py"),
      reloadCards.join(", "),
    );
    check("reload: inline image persists (meta.images)", reloadImgs > 0, `${reloadImgs} inline image(s)`);
    check(
      "reload: masking holds — no unpresented files resurrected",
      !reloadCards.some((c) => c.endsWith(".py") && c.trim() !== "gen.py") &&
        !reloadCards.some((c) => c.toLowerCase().endsWith(".png")),
      reloadCards.join(", "),
    );
  } finally {
    await browser.close();
    if (convId) {
      await db.conversation.delete({ where: { id: convId } }).catch(() => {});
      await rm(chatPoolDir(convId), { recursive: true, force: true }).catch(() => {});
    }
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
