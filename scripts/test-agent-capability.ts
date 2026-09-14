/**
 * Live harness — Stage 0 of the Sandbox agent tier: the capability card on
 * Admin → Tools. Requires `pnpm dev` running. Run:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-capability.ts
 *
 * Proves, in a real browser against the real server:
 *   1.  the Sandbox card renders on Admin → Tools with its defaults
 *   2.  the browser accepts the card's own default values (the Limits-form
 *       lesson: a bad step/min makes a form silently unsubmittable, invisible
 *       to every server-side test)
 *   3.  enable + save round-trips through saveCapability into settings
 *   4.  a changed field survives save + reload
 *   5.  subscription mode reveals the sign-in check, and clicking it reaches
 *       a REAL Agent SDK spawn — on a signed-in dev box it reports the
 *       account, and it must never claim an API key identity
 *   6.  the stored state reads back through getSandboxAgentState with parsed,
 *       defaulted config
 *
 * Snapshot-restores the capability setting and deletes its throwaway admin,
 * so the instance is left as found (test-failover's pattern).
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "agent-cap-1!";
const SETTING_KEY = "capability_sandbox_agent";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
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
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

/** The Sandbox card = the Card div whose heading is exactly "Sandbox". */
const card = (page: Page) =>
  page
    .locator("div")
    .filter({ has: page.locator('h3:text-is("Sandbox")') })
    .last();

async function main() {
  const stamp = Date.now();

  // Snapshot the real capability setting so the instance is left as found…
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  // …then CLEAR it, so the card renders from its own defaults.
  //
  // Without this the harness silently depends on instance state: an admin who
  // has configured the Sandbox (chosen subscription, raised the turn budget)
  // makes the "defaults" assertions fail on a perfectly healthy instance —
  // which is exactly what happened the first time someone actually used the
  // page. A test must establish the state it asserts about.
  await db.setting.deleteMany({ where: { key: SETTING_KEY } });

  const admin = await db.user.create({
    data: {
      email: `agent-cap-${stamp}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    await ctx.addCookies(await signIn(admin.email));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // --- 1. the card renders with its defaults --------------------------------
    await page.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    const c = card(page);
    await c.waitFor({ timeout: 15_000 });
    check("Sandbox card renders on Admin → Tools", await c.isVisible());
    check(
      "description names the agent workspace",
      (await c.textContent())!.includes("autonomous agent workspace"),
    );
    const model = c.locator('label:has(span:text-is("Model")) input');
    check("model defaults to claude-sonnet-5", (await model.inputValue()) === "claude-sonnet-5");
    const effort = c.locator('label:has(span:text-is("Reasoning effort")) select');
    check("effort defaults to high", (await effort.inputValue()) === "high");
    check(
      "API key is the default credential mode",
      await c.locator('input[name="sandbox-credential"]').first().isChecked(),
    );
    check(
      "API mode offers the stored Anthropic keys",
      (await c.locator("select option").count()) > 1,
    );

    // --- 2. the browser accepts the card's own defaults -----------------------
    const numbersValid = await c
      .locator('input[type="number"]')
      .evaluateAll((els) => els.every((el) => (el as HTMLInputElement).checkValidity()));
    check("every numeric default passes the browser's own validation", numbersValid);

    // --- 3. enable + save round-trips ----------------------------------------
    const enable = c.locator('label:has(span:text-is("Enable for this workspace")) input');
    // Re-click until React state moves — the hydration race every admin
    // harness in this repo has hit (see CLAUDE.md).
    for (let i = 0; i < 10 && !(await enable.isChecked()); i++) await enable.click();
    check("enable checkbox ticks", await enable.isChecked());
    await c.locator('button:text-is("Save")').click();
    await c.locator("text=Capability enabled.").waitFor({ timeout: 10_000 });
    check("save reports success", true);
    const stored1 = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    const val1 = stored1?.value as { enabled?: boolean; config?: { model?: string } } | null;
    check("setting row persisted enabled=true", val1?.enabled === true);
    check("setting row carries the model", val1?.config?.model === "claude-sonnet-5");

    // --- 4. a changed field survives save + reload ----------------------------
    const turns = c.locator('label:has(span:text-is("Max agent turns per run")) input');
    await turns.fill("25");
    await c.locator('button:text-is("Save")').click();
    await c.locator("text=Capability enabled.").waitFor({ timeout: 10_000 });
    // networkidle, not domcontentloaded: this page holds no SSE (unlike Admin
    // → Logs), and interacting before dev-mode hydration settles is exactly
    // the dead-window the debug run proved the radio clicks were landing in.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);
    const c2 = card(page);
    await c2.waitFor({ timeout: 15_000 });
    check(
      "changed maxTurns survives reload",
      (await c2.locator('label:has(span:text-is("Max agent turns per run")) input').inputValue()) === "25",
    );

    // --- 5. subscription mode + the live sign-in check ------------------------
    // The hydration race, radio edition: a pre-hydration click sets the DOM's
    // checked state (which isChecked() happily reports) while React state
    // never moved — and the conditional panel renders off React state. So the
    // loop polls for the CONSEQUENCE (the button React renders), not the
    // radio's own state.
    const subRadio = c2.locator('input[name="sandbox-credential"]').nth(1);
    const checkBtn = c2.locator('button:text-is("Check sign-in")');
    for (let i = 0; i < 15 && !(await checkBtn.isVisible().catch(() => false)); i++) {
      await subRadio.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    check("subscription mode reveals the sign-in check", await checkBtn.isVisible());
    await checkBtn.click();
    // A real SDK spawn — give it room. Whichever way it resolves, it must
    // render SOMETHING (signed-in identity or honest guidance), never hang.
    // "Signed in", not "Signed in as": the CLI reports the plan before the
    // email, so a quick probe legitimately renders the plan alone.
    const outcome = c2.locator("text=/Signed in|Not signed in|Timed out|Check failed/");
    await outcome.first().waitFor({ timeout: 40_000 });
    const outcomeText = (await outcome.first().textContent()) ?? "";
    check("sign-in check resolves to a rendered outcome", true, outcomeText);
    check(
      "sign-in check never claims an API-key identity",
      !/api key/i.test(outcomeText),
      outcomeText,
    );
    // The bug this guards: the probe used to run on the SERVER HOST and
    // report whatever account that machine was signed in as — a confident,
    // well-formed answer about the wrong computer. It must say where it
    // looked, and the source-level guard is in agent/account-check.test.ts.
    check(
      "sign-in check states it looked inside the container",
      /inside the agent container/i.test((await c2.textContent()) ?? ""),
    );

    // --- 6. typed read-back --------------------------------------------------
    const { getSandboxAgentState } = await import("../src/lib/capabilities/sandbox-agent");
    const state = await getSandboxAgentState();
    check("getSandboxAgentState: enabled", state.enabled);
    check("getSandboxAgentState: parsed maxTurns=25", state.config.maxTurns === 25);
    check("getSandboxAgentState: defaulted effort=high", state.config.effort === "high");

    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    // Leave the instance exactly as found.
    if (prior) {
      await db.setting.update({ where: { key: SETTING_KEY }, data: { value: prior.value as object } });
    } else {
      await db.setting.deleteMany({ where: { key: SETTING_KEY } });
    }
    await db.user.delete({ where: { id: admin.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
