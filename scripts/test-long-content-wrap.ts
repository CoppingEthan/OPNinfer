/**
 * Long unbroken strings must never widen the chat (owner bug, 2026-07-29: a
 * user's message ran off the screen and the whole thread scrolled sideways).
 *
 * Cause: `break-words` (`overflow-wrap: break-word`) lets text break visually
 * but does NOT reduce an element's min-content width — and min-content is what
 * a flex ancestor sizes to, so the bubble reserved the full unbroken width.
 * The fix is `overflow-wrap: anywhere` plus `min-w-0` on the flex children.
 *
 * Asserted at desktop AND mobile width, in the user's chat AND the admin
 * transcript (same component, so a regression in one is a regression in both).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-long-content-wrap.ts
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "wrap-test-1!";
const STAMP = Date.now();

/** The shapes that blew it out: a query-string URL and a spaceless token. */
const LONG_URL =
  "https://www.example.co.uk/products/plantation-shutters/full-height/?utm_source=newsletter" +
  "&utm_medium=email&utm_campaign=spring_2026_promo&utm_content=hero_button_variant_b" +
  "&session=abcdef0123456789abcdef0123456789";
const LONG_TOKEN = "A".repeat(200);

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

/** Widest horizontal overflow anywhere on the page.
 *
 *  `contentOverflow` is the layout-independent signal: a message whose own
 *  content is wider than its box. The scroller check only applies to the chat
 *  view (the admin transcript has no `[data-chat-scroll]`), so without this
 *  the admin assertions would pass vacuously. */
const MEASURE = `(() => {
  const doc = document.documentElement;
  const scroller = document.querySelector("[data-chat-scroll]");
  let beyondViewport = 0;
  let contentOverflow = 0;
  for (const el of document.querySelectorAll("[data-role]")) {
    beyondViewport = Math.max(beyondViewport, Math.round(el.getBoundingClientRect().right - window.innerWidth));
    contentOverflow = Math.max(contentOverflow, el.scrollWidth - el.clientWidth);
  }
  return {
    pageOverflow: doc.scrollWidth - doc.clientWidth,
    scrollerOverflow: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    bubbleBeyondViewport: beyondViewport,
    contentOverflow,
  };
})()`;

async function assertNoOverflow(page: Page, label: string) {
  const m = (await page.evaluate(MEASURE)) as {
    pageOverflow: number;
    scrollerOverflow: number;
    bubbleBeyondViewport: number;
    contentOverflow: number;
  };
  // 1px of tolerance for sub-pixel rounding.
  check(`${label}: page does not scroll sideways`, m.pageOverflow <= 1, `${m.pageOverflow}px`);
  check(`${label}: thread does not scroll sideways`, m.scrollerOverflow <= 1, `${m.scrollerOverflow}px`);
  check(`${label}: no bubble past the viewport`, m.bubbleBeyondViewport <= 1, `${m.bubbleBeyondViewport}px`);
  check(`${label}: message content fits its bubble`, m.contentOverflow <= 1, `${m.contentOverflow}px`);
}

async function main() {
  const email = `wrap-${STAMP}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  const convo = await db.conversation.create({
    data: {
      userId: user.id,
      title: `Wrap fixture ${STAMP}`,
      messages: {
        create: [
          { role: "user", content: `Have a look at ${LONG_URL} and tell me what you think.` },
          { role: "user", content: LONG_TOKEN },
          {
            role: "assistant",
            content: `That URL is ${LONG_URL} and here is a bare token ${LONG_TOKEN} in prose.`,
            model: "claude-sonnet-5",
          },
        ],
      },
    },
  });

  const browser = await chromium.launch();
  try {
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

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();

    // --- the user's own chat, desktop then mobile ------------------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='user']", { timeout: 30_000 });
    await assertNoOverflow(page, "chat @1280");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300); // let the layout settle
    await assertNoOverflow(page, "chat @390");

    // --- the admin transcript (same component, behind sudo) -------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/admin/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("input[type=password]", { timeout: 20_000 });
    await page.fill("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForSelector("table", { timeout: 20_000 });
    await page.goto(`${BASE}/admin/chats/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='assistant']", { timeout: 20_000 });
    await assertNoOverflow(page, "admin transcript @1280");

    // The text must still be readable, not clipped away.
    const body = await page.locator("body").innerText();
    check("the long URL is still present in the transcript", body.includes("utm_campaign"));
    await ctx.close();
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: convo.id } });
    await db.auditLog.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
