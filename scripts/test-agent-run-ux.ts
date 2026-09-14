/**
 * Live browser harness — the Sandbox run's UX (owner feedback, 2026-09-02):
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-run-ux.ts
 *
 * One real Sandbox job (write a script, run it, make a PNG, present it) and
 * a MutationObserver planted BEFORE the turn, because the transient states
 * cannot be polled after the fact. Proves:
 *   1. the code preview grows LIVE while the agent writes (≥3 distinct
 *      preview lengths sampled during the code phase — not one burst at the end)
 *   2. the presented image sits WHERE the agent presented it — after the
 *      working activity, before the final prose — not above everything
 *   3. once the reply is finished the working activity COLLAPSES into a
 *      "Worked through N steps" row; the deliverable and the final prose stay
 *      visible; clicking expands it; a reload lands collapsed again with the
 *      same order
 * Runs on the configured Sandbox credential (subscription = $0).
 */
import { chromium, type Page } from "@playwright/test";
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
const PASSWORD = "agent-run-ux-1!";
const TASK =
  "Use the Sandbox for this. Write a Python script table.py of about 40 lines that prints a 12×12 multiplication table with aligned columns and a header row, run it, then with Pillow create a 240×240 PNG called dot.png (dark blue background, one yellow circle) and present dot.png to me. Finish with two sentences describing what you made.";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
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

// Planted before the turn: records, per live code block, every distinct
// preview text length seen while it is in the "code" phase. A string, not a
// function — tsx injects a `__name` helper into closures that the browser
// context does not have.
const OBSERVER = `(() => {
  window.__oiCodeSamples = {};
  const sample = () => {
    document.querySelectorAll('[data-run-phase="code"]').forEach((el) => {
      const id = el.getAttribute('data-run') || 'run';
      const len = (el.textContent || '').length;
      const arr = (window.__oiCodeSamples[id] = window.__oiCodeSamples[id] || []);
      if (!arr.length || arr[arr.length - 1].len !== len) arr.push({ len, t: Date.now() });
    });
  };
  new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(sample, 100);
})()`;

/** DOM order of the pieces we care about inside the last assistant bubble. */
const ORDER = `(() => {
  const b = [...document.querySelectorAll("[data-role='assistant']")].pop();
  if (!b) return null;
  const all = [...b.querySelectorAll('[data-activity-collapsed], [data-activity="status"], [data-run], [data-activity="image"], [data-activity="files"], .markdown')];
  return all.map((el) => el.hasAttribute('data-activity-collapsed') ? 'collapsed'
    : el.getAttribute('data-activity') === 'image' ? 'image'
    : el.getAttribute('data-activity') === 'files' ? 'files'
    : el.hasAttribute('data-run') ? 'run'
    : el.getAttribute('data-activity') === 'status' ? 'status'
    : 'prose');
})()`;

async function waitTurn(page: Page, n: number, timeout: number) {
  await page.waitForFunction(
    `(() => {
      const bubbles = document.querySelectorAll("[data-role='assistant']");
      if (bubbles.length < ${n}) return false;
      const last = bubbles[bubbles.length - 1];
      const live = document.querySelector('[data-run-phase="code"], [data-run-phase="exec"]');
      return !live && !!last.querySelector("[aria-label='Retry']");
    })()`,
    undefined,
    { timeout },
  );
}

async function main() {
  const setting = await db.setting.findUnique({ where: { key: "capability_sandbox_agent" } });
  if (!(setting?.value as { enabled?: boolean } | null)?.enabled) {
    console.error("Enable the Sandbox capability first (Admin → Tools).");
    process.exit(1);
  }
  const user = await db.user.create({
    data: { email: `run-ux-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(OBSERVER);

    const t0 = Date.now();
    await page.locator("textarea").fill(TASK);
    await page.locator("textarea").press("Enter");

    // While it works: the activity must be VISIBLE (not collapsed).
    await page.locator('[data-run]').first().waitFor({ state: "visible", timeout: 180_000 }).catch(() => {});
    const collapsedMidRun = await page.locator("[data-activity-collapsed]").count();
    check("while working, the activity is expanded (no collapsed row)", collapsedMidRun === 0);

    await waitTurn(page, 1, 12 * 60_000);
    console.log(`  (turn took ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    await page.waitForTimeout(1_500); // paced reveal drains

    // 1. live code
    const samples = (await page.evaluate("window.__oiCodeSamples")) as Record<string, { len: number; t: number }[]>;
    // Only samples with CONTENT count — the empty block appearing is not an
    // update (an earlier version of this check counted it and was fooled by
    // "appear, 15s of silence, burst").
    const blocks = Object.values(samples).map((a) => {
      const c = a.filter((x) => x.len > 8);
      return {
        n: new Set(c.map((x) => x.len)).size,
        spreadMs: c.length ? c[c.length - 1].t - c[0].t : 0,
        silenceMs: c.length ? c[0].t - a[0].t : Infinity,
      };
    });
    const big = blocks.filter((b) => b.n >= 3).sort((a, b) => b.spreadMs - a.spreadMs)[0];
    check("code preview grew LIVE while the agent wrote (≥3 distinct content lengths in one block)", !!big, `per block: ${blocks.map((b) => `${b.n} updates over ${(b.spreadMs / 1000).toFixed(1)}s after ${b.silenceMs === Infinity ? "∞" : (b.silenceMs / 1000).toFixed(1)}s`).join(" | ") || "none"}`);
    check("…spread over time, not one burst at the end", !!big && big.spreadMs >= 1_500, big ? `${(big.spreadMs / 1000).toFixed(1)}s between first and last content update` : "no block");
    check("…and the first content arrived promptly (no long silence = fine-grained streaming on)", !!big && big.silenceMs < 3_000, big ? `${(big.silenceMs / 1000).toFixed(1)}s from block appearing to first content` : "no block");

    convId = (await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }))?.id ?? null;

    // 2 + 3. order after completion
    const order = (await page.evaluate(ORDER)) as string[] | null;
    check("finished reply shows a collapsed working row", !!order && order.includes("collapsed"), (order ?? []).join(" > "));
    const imgCount = await page.locator("[data-role='assistant'] img").count();
    check("the presented image is visible", imgCount >= 1, `${imgCount} image(s)`);
    if (order) {
      const c = order.indexOf("collapsed");
      const im = order.indexOf("image");
      const lastProse = order.lastIndexOf("prose");
      check("image sits AFTER the collapsed activity and BEFORE the final prose", c >= 0 && im > c && lastProse > im, order.join(" > "));
      check("no loose status/run rows outside the collapsed region", !order.some((x, i) => (x === "status" || x === "run") && i > c), order.join(" > "));
    }

    // expand
    await page.locator("[data-activity-collapsed]").first().click();
    await page.waitForTimeout(300);
    const expanded = (await page.evaluate(ORDER)) as string[] | null;
    check("clicking expands the working steps", !!expanded && expanded.filter((x) => x === "run" || x === "status").length >= 2, (expanded ?? []).join(" > "));
    if (expanded) {
      // The image belongs AFTER the run that made it (the present point); a
      // status line after it is legitimate — the agent may still narrate.
      const lastRun = expanded.lastIndexOf("run");
      const im = expanded.indexOf("image");
      check("expanded: the image is positioned after the runs, at the present point", im > lastRun && lastRun >= 0, expanded.join(" > "));
    }

    // reload → collapsed again, same order
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const after = (await page.evaluate(ORDER)) as string[] | null;
    check("after reload: collapsed again", !!after && after.includes("collapsed"), (after ?? []).join(" > "));
    if (after) {
      const c = after.indexOf("collapsed");
      const im = after.indexOf("image");
      check("after reload: image still after the activity and before the final prose", c >= 0 && im > c && after.lastIndexOf("prose") > im, after.join(" > "));
    }
    const reloadImgs = await page.locator("[data-role='assistant'] img").count();
    check("after reload: the image is still there, once", reloadImgs === 1, `${reloadImgs}`);

    // --- turn 2: re-present the SAME filename with new bytes (owner bug
    // 2026-09-02: a recoloured design under the same name showed the old
    // bitmap until a reload — the browser's in-page image cache keys on the
    // URL, so the URL must change when the bytes do).
    const firstSrc = (await page.locator("[data-role='assistant'] img").first().getAttribute("src")) ?? "";
    const t2 = Date.now();
    await page.locator("textarea").fill("Now change dot.png so the circle is RED instead of yellow — overwrite the same file dot.png — and present it to me again. One sentence when done.");
    await page.locator("textarea").press("Enter");
    await waitTurn(page, 2, 8 * 60_000);
    console.log(`  (turn 2 took ${((Date.now() - t2) / 1000).toFixed(0)}s)`);
    await page.waitForTimeout(1_000);
    const srcs = await page.locator("[data-role='assistant'] img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
    const secondSrc = srcs[srcs.length - 1] ?? "";
    check("re-presented file gets a NEW versioned URL (same file id, different ?v=)", srcs.length >= 2 && secondSrc.split("?")[0] === firstSrc.split("?")[0] && secondSrc !== firstSrc && /[?&]v=\d+/.test(secondSrc), `${firstSrc} → ${secondSrc}`);
    const [b1, b2] = await Promise.all([page.request.get(`${BASE}${firstSrc}`), page.request.get(`${BASE}${secondSrc}`)]);
    const bytes2 = await b2.body();
    // Both URLs name the same file, so both now serve the NEW bytes — the
    // point is that the new URL is what the browser's image cache sees.
    check("…and both versioned URLs serve the file", b1.ok() && b2.ok() && bytes2.length > 0, `${(await b1.body()).length} and ${bytes2.length} bytes`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const srcsAfter = await page.locator("[data-role='assistant'] img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
    check("after reload the second reply still carries its own version", srcsAfter.length >= 2 && srcsAfter[srcsAfter.length - 1] === secondSrc, srcsAfter.join(" | "));
  } finally {
    await browser.close();
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
  process.exit(1);
});
