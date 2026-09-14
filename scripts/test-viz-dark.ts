/**
 * Inline visuals in DARK mode (owner bug, 2026-09-04): the chart's frame
 * stayed WHITE while its text went light — unreadable. The model's SVG was
 * clean (theme variables only); the white came from the browser. The app
 * sets `color-scheme: dark` on <html>, the frame's own document said
 * nothing (= light), and when an iframe's colour scheme differs from its
 * embedder's, Chromium paints an OPAQUE canvas behind it instead of letting
 * the page show through (CSS Color Adjust — a deliberate rule, so a light
 * page can't become unreadable inside a dark one). The frame's
 * `background: transparent` was simply never honoured in dark mode.
 *
 * This seeds the OWNER'S exact chart into a chat and, in a real browser, in
 * both themes, measures the frame's canvas pixels against the card's own
 * surface colour — a screenshot, because no DOM property reports the opaque
 * backdrop. Verified to FAIL before the fix (dark canvas = rgb(255,255,255)).
 *
 *   TEST_BASE_URL=http://localhost:3000 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-viz-dark.ts
 */
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "viz-dark-1!";
const TITLE = "Max income multiple by lender";

// The owner's chart, verbatim from the live instance (message de14fc8e).
const SVG = `<svg viewBox="0 0 720 340" width="100%" font-family="var(--font-sans)">
  <style>
    text{fill:var(--fg);font-size:12px}
    .lbl{fill:var(--muted);font-size:11px}
  </style>
  <g>
    <rect x="160" y="20" width="455" height="26" fill="var(--blue-fill)" stroke="var(--blue)"/>
    <text x="10" y="38">HSBC (Premier, £100k+)</text>
    <text x="620" y="38">6.5x</text>
    <rect x="160" y="56" width="420" height="26" fill="var(--teal-fill)" stroke="var(--teal)"/>
    <text x="10" y="74">Nationwide Helping Hand</text>
    <text x="585" y="74">6x</text>
    <rect x="160" y="92" width="420" height="26" fill="var(--teal-fill)" stroke="var(--teal)"/>
    <text x="10" y="110">Barclays (£75k+)</text>
    <text x="585" y="110">6x</text>
    <rect x="160" y="200" width="385" height="26" fill="var(--amber-fill)" stroke="var(--amber)"/>
    <text x="10" y="218">Halifax FTB Boost</text>
    <text x="550" y="218">5.5x</text>
    <rect x="160" y="308" width="385" height="26" fill="var(--amber-fill)" stroke="var(--amber)"/>
    <text x="10" y="326">Accord Boost LTI</text>
    <text x="550" y="326">5.5x</text>
  </g>
</svg>`;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
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
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

type Rgb = [number, number, number];
function parseRgb(s: string): Rgb | null {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const near = (a: Rgb, b: Rgb, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (c: Rgb) => `rgb(${c.join(",")})`;

async function runTheme(browser: Browser, cookies: Awaited<ReturnType<typeof signIn>>, convId: string, theme: "light" | "dark") {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: theme });
  await ctx.addCookies(cookies);
  // next-themes reads this key; pin the choice rather than rely on the system match.
  await ctx.addInitScript(`try { localStorage.setItem("theme", ${JSON.stringify(theme)}) } catch {}`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/chat/${convId}`, { waitUntil: "domcontentloaded" });
  const frameSel = `iframe[title="${TITLE}"]`;
  await page.waitForSelector(frameSel, { timeout: 30_000 });
  await page.waitForFunction(
    `document.documentElement.classList.contains("dark") === ${theme === "dark"}`,
    null,
    { timeout: 10_000 },
  );
  // The frame reports its height once the SVG is in; wait for it to grow past the 120px default.
  await page.waitForFunction(`(document.querySelector('${frameSel}')?.getBoundingClientRect().height ?? 0) > 200`, null, { timeout: 15_000 });
  await page.waitForTimeout(600);

  const htmlDark = await page.evaluate("document.documentElement.classList.contains('dark')");
  check(`[${theme}] page is in ${theme} mode`, htmlDark === (theme === "dark"));

  const surface = parseRgb(await page.$eval(frameSel, (el) => getComputedStyle(el.closest("figure")!).backgroundColor));
  const embedderScheme = await page.evaluate("getComputedStyle(document.documentElement).colorScheme");
  check(`[${theme}] embedder color-scheme is ${theme}`, embedderScheme === theme, String(embedderScheme));

  // The frame's own word on its colour scheme (srcdoc frame, evaluated over CDP).
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith("about:srcdoc"));
  let frameScheme = "(frame not reachable)";
  try { frameScheme = String(await frame?.evaluate("getComputedStyle(document.documentElement).colorScheme")); } catch (e) { frameScheme = `(evaluate failed: ${(e as Error).message.slice(0, 60)})`; }
  check(`[${theme}] frame document color-scheme matches the page`, frameScheme === theme, frameScheme);

  const handle = (await page.$(frameSel))!;
  const box = (await handle.boundingBox())!;
  const png = await handle.screenshot({ path: `logs/viz-${theme}.png` });
  const w = Math.round(box.width), h = Math.round(box.height);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Rgb => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // Two canvas points nothing is drawn on: the top-right of the frame's
  // padding and the bottom edge, clear of the card's 16px rounded corner
  // (which clips the frame's bottom corners to the PAGE background).
  const samples: Array<[string, number, number]> = [["top-right", w - 3, 2], ["bottom", 30, h - 2]];
  for (const [name, x, y] of samples) {
    const px = at(x, y);
    check(
      `[${theme}] frame canvas at ${name} equals the card surface`,
      !!surface && near(px, surface),
      `canvas ${fmt(px)} vs surface ${surface ? fmt(surface) : "?"}`,
    );
  }
  // And the labels really are readable: scan the first label's box for its
  // ink extreme (darkest in light, brightest in dark) and require real
  // contrast against the canvas. Before the fix, dark mode read ~12.
  const s = (w - 4) / 720;
  const luma = (c: Rgb) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
  let ink = theme === "dark" ? 0 : 255;
  for (let y = Math.round(4 + 26 * s); y <= Math.round(4 + 42 * s); y++) {
    for (let x = Math.round(2 + 10 * s); x <= Math.round(2 + 130 * s); x++) {
      const l = luma(at(x, y));
      ink = theme === "dark" ? Math.max(ink, l) : Math.min(ink, l);
    }
  }
  const canvasLuma = luma(at(w - 3, 2));
  const contrast = Math.abs(ink - canvasLuma);
  check(`[${theme}] label ink contrasts with the canvas`, contrast > 100, `ink luma ${Math.round(ink)} vs canvas ${Math.round(canvasLuma)} (Δ${Math.round(contrast)})`);
  await ctx.close();
}

/**
 * Audit 2026-09-05: the sandbox stops top-navigation and popups, not the
 * frame navigating ITSELF — injected model HTML could swap the chart for an
 * external look-alike page under the portal's chrome. The parent now counts
 * loads and remounts the frame on a second one. Seed a visual that tries it
 * and check the frame is back on its own shell.
 */
async function navigationGuard(browser: Browser, cookies: Awaited<ReturnType<typeof signIn>>, userId: string) {
  const title = "Navigation attempt";
  const convo = await db.conversation.create({ data: { userId, title: "🧪 nav" } });
  await db.message.createMany({
    data: [
      { conversationId: convo.id, userId, role: "user", content: "Draw something." },
      {
        conversationId: convo.id,
        role: "assistant",
        content: "Here.",
        meta: { viz: [{ title, html: `<p id="mine">legit chart</p><script>location.href="https://example.com/";</script>` }] },
      },
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const warnings: string[] = [];
  page.on("console", (m) => { if (m.type() === "warning" && /navigate its frame/.test(m.text())) warnings.push(m.text()); });
  await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`iframe[title="${title}"]`, { timeout: 30_000 });
  await page.waitForTimeout(4000);
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  const external = frames.filter((f) => /example\.com/.test(f.url()));
  const own = frames.filter((f) => f.url().startsWith("about:srcdoc"));
  const blocked = (await page.$("[data-viz-blocked]")) !== null;
  check("the frame did not stay on the external page", external.length === 0, frames.map((f) => f.url()).join(" | "));
  check("the visual is back on its own shell, or blocked after repeated attempts", own.length >= 1 || blocked, blocked ? "blocked notice shown" : `${own.length} own frame(s)`);
  check("the parent noticed and logged the reset", warnings.length >= 1, `${warnings.length} warning(s)`);
  await ctx.close();
  await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
}

async function main() {
  const user = await db.user.create({
    data: { email: `viz-dark-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "📊 Lender multiples" } });
  await db.message.createMany({
    data: [
      { conversationId: convo.id, userId: user.id, role: "user", content: "Chart the max income multiple by lender." },
      { conversationId: convo.id, role: "assistant", content: "Here is how the lenders compare.", meta: { viz: [{ title: TITLE, html: SVG }] } },
    ],
  });
  const browser = await chromium.launch();
  try {
    const cookies = await signIn(user.email);
    await runTheme(browser, cookies, convo.id, "light");
    await runTheme(browser, cookies, convo.id, "dark");
    await navigationGuard(browser, cookies, user.id);
  } finally {
    await browser.close();
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
