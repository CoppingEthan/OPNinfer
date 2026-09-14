/**
 * Live test: the tool-round budget is admin-configurable and actually honoured.
 *
 * Owner ask 2026-08-03 — long jobs kept exhausting the hard-coded budget of 6
 * and users had to keep typing "continue". The number now lives in
 * Admin → Models → Limits.
 *
 * Proving it needs a task that WANTS more rounds than it's given, so the cap
 * is what stops it rather than the model finishing early. The prompt below
 * forces strictly sequential tool calls (each depends on the last), then the
 * harness counts the conversation-model calls that actually went out —
 * recorded in usage_records, so this counts what was BILLED, not what we hoped.
 *
 *   1. A low budget (2) is respected — the loop stops there.
 *   2. A higher budget (5) on the same prompt genuinely runs more rounds.
 *   3. Either way the user still gets a real answer, never an empty turn.
 *   4. The setting round-trips through Admin → Models.
 *   5. The Limits form can SAVE ITS OWN DEFAULTS in a real browser. It could
 *      not from v0.3.1 until 2026-08-03: `min=1024 step=1024` made the browser
 *      reject the default 64,000 output ceiling (not a multiple of 1024), so
 *      Save silently did nothing. Only a real browser catches that — the
 *      server action never saw the request, so no server-side test could.
 *
 * Costs a few pennies of real tokens. Restores the instance's original limits.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-tool-rounds.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { DEFAULT_LIMITS, getTokenLimits, setTokenLimits } from "../src/lib/limits";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "rounds-user-1!";
const STAMP = Date.now();

/** Sequential by construction: each step needs the previous step's output,
 *  so the model cannot batch them into one round. (Used to chain the old
 *  sandbox's execute_command; now chains date_time_diff, whose answer feeds
 *  the next call's date.) */
const PROMPT =
  "Do these one at a time, each in its OWN separate date_time_diff tool call, " +
  "never combined, because each step depends on the previous result: " +
  "(1) count the days from now until 2027-03-01 and call it N1; " +
  "(2) count the days from now until the date that is N1 days AFTER 2027-03-01, call it N2; " +
  "(3) count the days from now until the date that is N2 days AFTER 2027-03-01, call it N3; " +
  "(4) count the days from now until the date that is N3 days AFTER 2027-03-01, call it N4; " +
  "(5) count the days from now until the date that is N4 days AFTER 2027-03-01, call it N5; " +
  "(6) count the days from now until the date that is N5 days AFTER 2027-03-01, call it N6; " +
  "(7) finally list N1 to N6. Do not batch the steps and do not compute any of them yourself.";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

async function main() {
  const original = await getTokenLimits();
  const user = await db.user.create({
    data: {
      email: `rounds-${STAMP}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  const jar = new Map<string, string>();
  const store = (cs: string[]) => {
    for (const c of cs) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  /** Run the prompt in a fresh chat under `rounds`; return billed calls + text. */
  async function runUnder(rounds: number): Promise<{ calls: number; text: string }> {
    await setTokenLimits({ ...original, maxToolRounds: rounds });
    // limits are cached ~30s in-process; the app is a separate process, so
    // wait out its TTL rather than racing it.
    await new Promise((r) => setTimeout(r, 31_000));

    const convo = await db.conversation.create({
      data: { userId: user.id, title: `rounds-${rounds}` },
    });
    const since = new Date();
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id, content: PROMPT }),
    });
    let full = "";
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += dec.decode(value, { stream: true });
      }
    }
    const text = [...full.matchAll(/^data: (.+)$/gm)]
      .map((m) => {
        try {
          return JSON.parse(m[1]) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string)
      .join("");

    // Billed conversation-role calls == loop iterations that actually ran.
    const calls = await db.usageRecord.count({
      where: { userId: user.id, role: "conversation", createdAt: { gte: since } },
    });
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    return { calls, text };
  }

  try {
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    check(
      "the setting round-trips",
      (await (async () => {
        await setTokenLimits({ ...original, maxToolRounds: 9 });
        return (await getTokenLimits()).maxToolRounds;
      })()) === 9,
    );

    const low = await runUnder(2);
    // Budget 2 → rounds 0,1 offer tools + the final round = at most 3 calls,
    // plus at most one forced tool-free answer pass.
    check(
      "a budget of 2 is respected (loop stopped early)",
      low.calls <= 4,
      `${low.calls} conversation-model calls`,
    );
    check("…and the user still got an answer", low.text.trim().length > 0, low.text.slice(0, 120));

    const high = await runUnder(5);
    check(
      "a budget of 5 genuinely runs more rounds than 2",
      high.calls > low.calls,
      `${high.calls} calls at 5 vs ${low.calls} at 2`,
    );
    check("…and that answer is real too", high.text.trim().length > 0, high.text.slice(0, 120));

    // --- the form itself, in a real browser --------------------------------
    await setTokenLimits(DEFAULT_LIMITS);
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
      await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/models`, { waitUntil: "domcontentloaded" });

      const out = page.locator('input[name="maxOutputTokens"]');
      await out.waitFor({ state: "visible", timeout: 20_000 });

      // The browser's own verdict on the UNTOUCHED default — this is exactly
      // what blocked Save before, and it fails without needing a click.
      const valid = await out.evaluate((el) => (el as HTMLInputElement).checkValidity());
      const message = await out.evaluate((el) => (el as HTMLInputElement).validationMessage);
      check(
        "the default output ceiling is accepted by the browser",
        valid,
        valid ? "" : `rejected: ${message}`,
      );

      // And prove the whole form actually round-trips untouched.
      await setTokenLimits({ ...DEFAULT_LIMITS, maxToolRounds: 3 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('input[name="maxToolRounds"]').waitFor({ state: "visible", timeout: 20_000 });
      for (let i = 0; i < 20; i++) {
        await page.locator('input[name="maxToolRounds"]').fill("11");
        if ((await page.locator('input[name="maxToolRounds"]').inputValue()) === "11") break;
        await page.waitForTimeout(250);
      }
      await page.getByRole("button", { name: /save limits/i }).click();
      await page.getByText(/limits saved/i).waitFor({ timeout: 20_000 });
      const saved = await getTokenLimits();
      check(
        "saving the form persists every field",
        saved.maxToolRounds === 11 &&
          saved.maxOutputTokens === DEFAULT_LIMITS.maxOutputTokens &&
          saved.maxInputTokens === DEFAULT_LIMITS.maxInputTokens,
        `out=${saved.maxOutputTokens} in=${saved.maxInputTokens} rounds=${saved.maxToolRounds}`,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await setTokenLimits(original).catch(() => {});
    const restored = await getTokenLimits().catch(() => null);
    check(
      "the instance's original limits were restored",
      restored?.maxToolRounds === original.maxToolRounds,
      `maxToolRounds=${restored?.maxToolRounds}`,
    );
    await db.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL TOOL-ROUND CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
