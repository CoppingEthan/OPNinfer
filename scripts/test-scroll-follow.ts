/**
 * Live browser test for the stick-to-bottom scroll rework: while a reply
 * streams the thread eases down smoothly; scrolling UP releases the follow
 * (the user is never yanked back — the old loop pinned scrollTop every frame,
 * which made escaping impossible); a floating ↓ button appears when released;
 * clicking it (or scrolling back to the bottom) re-arms the follow.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-scroll-follow.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "scroll-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

type Metrics = { top: number; height: number; client: number; dist: number; jumpShown: boolean };

async function main() {
  const user = await db.user.create({
    data: { email: `scroll-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "scroll test" } });
  // Seed enough history that the thread scrolls well past one viewport.
  const para = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of filler text for the scroll harness.`).join("\n");
  for (let i = 0; i < 10; i++) {
    await db.message.create({ data: { conversationId: convo.id, role: i % 2 ? "assistant" : "user", content: `Message ${i + 1}.\n${para}` } });
  }

  const browser = await chromium.launch();
  try {
    // API login → inject the session cookie into the browser context.
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    const metrics = () => page.evaluate((): Metrics => {
      const el = document.querySelector("[data-chat-scroll]") as HTMLElement;
      const btn = document.querySelector('[aria-label="Scroll to bottom"]') as HTMLElement | null;
      return {
        top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
        dist: el.scrollHeight - el.scrollTop - el.clientHeight,
        jumpShown: btn?.getAttribute("aria-hidden") === "false",
      };
    });

    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-chat-scroll]");
    await page.waitForTimeout(400);

    // ── Idle behavior on a loaded chat ──────────────────────────────────
    let m = await metrics();
    check("loads pinned to the bottom", m.dist < 5, `dist=${m.dist.toFixed(1)}`);
    check("↓ button hidden while at the bottom", !m.jumpShown);

    await page.mouse.move(720, 360);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(350);
    m = await metrics();
    const restingTop = m.top;
    check("wheel-up scrolls away from the bottom (idle)", m.dist > 200, `dist=${m.dist.toFixed(0)}`);
    check("↓ button appears once scrolled up", m.jumpShown);
    await page.waitForTimeout(600);
    m = await metrics();
    check("position holds while idle (no re-pin)", Math.abs(m.top - restingTop) < 2, `drift=${(m.top - restingTop).toFixed(1)}px`);

    await page.getByLabel("Scroll to bottom").click();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-chat-scroll]") as HTMLElement;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    }, undefined, { timeout: 3000 });
    m = await metrics();
    check("↓ click glides back to the bottom", m.dist < 10, `dist=${m.dist.toFixed(1)}`);
    check("↓ button hides again", !m.jumpShown);

    // ── Streaming behavior ──────────────────────────────────────────────
    const ta = page.locator("textarea");
    // A fenced code block keeps one-number-per-line geometry even after the
    // finished reply re-renders as markdown (plain newlines would collapse
    // into a single paragraph and yank the page height mid-assertion).
    await ta.fill("Output a markdown code block containing the numbers 1 to 400, one number per line. Nothing else, no tools.");
    const preHeight = (await metrics()).height;
    await ta.press("Enter");

    // Wait until the reply is actually flowing (revealed content growing).
    await page.waitForFunction((h0) => {
      const el = document.querySelector("[data-chat-scroll]") as HTMLElement;
      return el.scrollHeight > h0 + 300;
    }, preHeight, { timeout: 60000 });

    // A) follow: the thread tracks growth, staying near the bottom.
    const a1 = await metrics();
    await page.waitForTimeout(700);
    const a2 = await metrics();
    check("(stream) content is growing", a2.height > a1.height, `+${a2.height - a1.height}px`);
    check("(stream) auto-follow keeps the thread near the bottom", a1.dist < 150 && a2.dist < 150, `dist=${a1.dist.toFixed(0)}→${a2.dist.toFixed(0)}`);
    check("(stream) ↓ button hidden while following", !a2.jumpShown);

    // B) release: wheel up mid-stream → the position must HOLD exactly.
    await page.mouse.wheel(0, -800);
    await page.waitForTimeout(250);
    const b1 = await metrics();
    check("(stream) wheel-up escapes the follow", b1.dist > 300, `dist=${b1.dist.toFixed(0)}`);
    await page.waitForTimeout(1200);
    const b2 = await metrics();
    check("(stream) reading position holds EXACTLY while tokens flow", Math.abs(b2.top - b1.top) < 5, `drift=${(b2.top - b1.top).toFixed(1)}px over 1.2s`);
    check("(stream) content kept growing underneath", b2.height > b1.height, `+${b2.height - b1.height}px`);
    check("(stream) ↓ button visible while released", b2.jumpShown);

    // C) re-arm via the ↓ button: eases down, then follows again.
    await page.getByLabel("Scroll to bottom").click();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-chat-scroll]") as HTMLElement;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }, undefined, { timeout: 4000 });
    await page.waitForTimeout(700);
    const c1 = await metrics();
    check("(stream) ↓ click returns to the bottom and RESUMES following", c1.dist < 150, `dist=${c1.dist.toFixed(0)}`);

    // D) release again, then re-arm by scrolling to the bottom manually
    //    (several wheel ticks, like a real user — the last one clamps at the
    //    bottom, which is the re-arm signal).
    await page.mouse.wheel(0, -800);
    await page.waitForTimeout(300);
    const d1 = await metrics();
    check("(stream) second wheel-up releases again", d1.dist > 300, `dist=${d1.dist.toFixed(0)}`);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700);
    const d2 = await metrics();
    check("(stream) scrolling back to the bottom re-arms the follow", d2.dist < 150, `dist=${d2.dist.toFixed(0)} (height ${d1.height}→${d2.height})`);

    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL SCROLL-FOLLOW CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
