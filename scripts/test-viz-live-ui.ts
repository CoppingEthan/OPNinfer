/**
 * Browser-level test of LIVE visualization rendering (owner bug, 2026-07-13):
 * the chart appeared only after a page refresh — streamed HTML was pushed into
 * the sandboxed iframe before its listener script booted (Anthropic's bursty
 * deltas can deliver the whole fragment in one go), so the frame stayed blank.
 * Fixed with a ready-handshake (shell posts __oiVizReady → parent re-delivers
 * the latest HTML). Also covers the repeat-declaration fix: render_visualization
 * called again in the same turn now gets a hard "stop calling tools" result.
 *
 *  1. Send a bar-chart prompt in a REAL browser; wait for the reply to finish.
 *  2. WITHOUT reloading: the viz iframe must contain rendered SVG content.
 *  3. "Drawing a visualization" status lines ≤ 2 (was 4 pre-fix).
 *  4. Reload → chart still renders from meta.viz (checklist 10.2).
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-viz-live-ui.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "viz-ui-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `viz-ui-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
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
    const ta = page.locator("textarea");
    await ta.fill("Draw me a bar chart of our quarterly revenue this year: Q1 £48k, Q2 £61k, Q3 £57k, Q4 £74k. Clean and professional please.");
    await ta.press("Enter");

    // Wait for the turn to fully finish: a viz frame exists, its "rendering…"
    // pulse is gone, and reply text is present. Generous timeout — the model
    // loads the visualize skill first and CPU rounds take a while.
    await page.waitForFunction(
      () => {
        const fig = document.querySelector("figure");
        const cap = fig?.querySelector("figcaption");
        const bubble = document.querySelector("[data-role='assistant']") as HTMLElement | null;
        return !!fig && !!cap && !/rendering…/.test(cap.textContent ?? "") && !!bubble && bubble.innerText.length > 40;
      },
      undefined,
      { timeout: 300_000 },
    );
    check("reply finished with a viz frame present", true);
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);

    // The declaration tool is RETIRED (2026-07-13) — the protocol block
    // teaches direct marker emission, so no viz tool statuses should exist
    // and the fragment streams without any tool round-trips.
    const drawingLines = await page.evaluate(
      () => Array.from(document.querySelectorAll("[data-role='assistant'] span")).filter((s) => /Drawing a visualization|render_visualization/i.test(s.textContent ?? "")).length,
    );
    check("no viz declaration tool statuses (tool retired)", drawingLines === 0, `${drawingLines} line(s)`);

    // Title extracted from the START marker line by the parser.
    const caption = await page.locator("figure figcaption").first().innerText();
    check("frame carries a real title from the marker line", caption.trim().length > 3 && !/^Visualization$/i.test(caption.trim()), caption.trim());

    // THE bug: chart must be visible NOW, without any reload.
    const frame = page.frameLocator("figure iframe");
    const liveSvg = await frame.locator("#root svg, #root table, #root div").count();
    const liveHtmlLen = await frame.locator("#root").evaluate((el) => el.innerHTML.length).catch(() => 0);
    check("chart rendered LIVE (no reload needed)", liveSvg > 0 && liveHtmlLen > 100, `${liveSvg} node(s), ${liveHtmlLen} chars in frame`);

    const frameHeight = await page.locator("figure iframe").evaluate((el) => (el as HTMLElement).offsetHeight);
    check("frame sized to its content (height report)", frameHeight > 100, `${frameHeight}px`);

    // Reload → persisted meta.viz renders again (checklist 10.2).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("figure iframe", { timeout: 30_000 });
    const reloadedLen = await page
      .frameLocator("figure iframe")
      .locator("#root")
      .evaluate((el) => el.innerHTML.length)
      .catch(() => 0);
    check("chart survives reload (meta.viz)", reloadedLen > 100, `${reloadedLen} chars`);
  } finally {
    await browser.close();
    if (convId) {
      await db.conversation.delete({ where: { id: convId } }).catch(() => {});
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
