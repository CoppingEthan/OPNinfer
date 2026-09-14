/**
 * Browser-level test of INTERLEAVED reply timelines (owner bug, 2026-07-19):
 * Anthropic narrates between tool calls, but the UI used to lump ALL activity
 * above ALL text — and plain status lines vanished entirely on refresh.
 * Now every activity item carries a reply-text offset (`at`), the bubble
 * renders prose → activity → prose chronologically, and the ordered log
 * persists in meta.activity.
 *
 *  1. A narrate-between-calls prompt → the DOM order of the reply must be
 *     text BEFORE the first status line and text AFTER the last one.
 *  2. Reload → the same statuses render in the SAME positions (persistence).
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-activity-interleave.ts
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "interleave-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

/** Walk the last reply's DOM in order: "T" = non-empty markdown block,
 *  "A:<label>" = a status row. Passed as a STRING (tsx __name gotcha). */
/** Since 2026-09-02 a FINISHED reply folds its working steps into one
 *  "Worked through N steps" row (deliverables + final prose stay visible).
 *  The order underneath is unchanged — expand before walking. */
async function expandFoldedSteps(page: Page) {
  const folded = page.locator("[data-role='assistant'] [data-activity-collapsed]");
  if ((await folded.count()) > 0) {
    await folded.last().click();
    await page.waitForTimeout(250);
  }
}

async function sequence(page: Page): Promise<string[]> {
  await expandFoldedSteps(page);
  return page.evaluate(`(() => {
    const bubbles = document.querySelectorAll("[data-role='assistant']");
    const last = bubbles[bubbles.length - 1];
    if (!last) return [];
    const out = [];
    for (const el of last.querySelectorAll(".markdown, [data-activity='status'], [data-run]")) {
      if (el.classList.contains("markdown")) {
        if ((el.innerText ?? "").trim().length > 0) out.push("T");
      } else if (el.getAttribute("data-activity") === "status") {
        out.push("A:" + (el.innerText ?? "").trim());
      } else {
        out.push("R");
      }
    }
    return out;
  })()`) as Promise<string[]>;
}

async function main() {
  const user = await db.user.create({
    data: { email: `interleave-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
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
    await ta.fill(
      "Do this in stages, narrating as you go: first write one short sentence saying you'll check Tokyo's time, then check the current time in Tokyo. Then write another short sentence before computing how many days remain until 2027-01-01, then compute it. Finish with a one-line summary of both results.",
    );
    await ta.press("Enter");
    await page.waitForFunction(
      `(() => {
        const bubbles = document.querySelectorAll("[data-role='assistant']");
        const last = bubbles[bubbles.length - 1];
        return !!last && !!last.querySelector("[aria-label='Retry']");
      })()`,
      undefined,
      { timeout: 300_000 },
    );
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);

    const seq = await sequence(page);
    const firstA = seq.findIndex((s) => s.startsWith("A:"));
    const lastA = seq.map((s) => s.startsWith("A:")).lastIndexOf(true);
    const statuses = seq.filter((s) => s.startsWith("A:"));
    check("reply contains ≥2 status lines", statuses.length >= 2, seq.join(" | "));
    check("prose renders BEFORE the first tool status (interleave, not lumped)", firstA > 0 && seq.slice(0, firstA).includes("T"), seq.join(" | "));
    check("prose renders AFTER the last tool status (final answer below)", seq.slice(lastA + 1).includes("T"), seq.join(" | "));

    // Reload: the ordered timeline must reproduce exactly (statuses used to
    // vanish entirely on refresh — meta.activity now persists them).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='assistant']", { timeout: 30_000 });
    const seq2 = await sequence(page);
    const statuses2 = seq2.filter((s) => s.startsWith("A:"));
    check("statuses survive reload (used to vanish)", statuses2.length === statuses.length, statuses2.join(" | "));
    check("status labels identical after reload", JSON.stringify(statuses2) === JSON.stringify(statuses), "");
    check("interleaved ORDER identical after reload", JSON.stringify(seq2) === JSON.stringify(seq), seq2.join(" | "));
  } finally {
    await browser.close();
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
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
