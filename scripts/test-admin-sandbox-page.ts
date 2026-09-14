/**
 * Live browser harness — the Sandbox admin page (owner ask, 2026-09-02).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-admin-sandbox-page.ts
 *
 * No model calls. Proves, against the real app:
 *   - capability OFF: no "Sandbox" tab in the admin nav; /admin/sandbox bounces
 *     to Tools; the Tools card is just the switch
 *   - flipping the switch ON from Tools does NOT reset the stored settings
 *   - capability ON: the tab appears; the page shows service status, the
 *     configuration form (with the stored model), plan usage (subscription) and
 *     "What the agent reaches for"; the Tools card links to it
 *   - OFF again: tab gone, page bounces
 * Restores the capability's prior state.
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

try {
  process.loadEnvFile(".env");
} catch {
  /* env already present */
}

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "sandbox-page-1!";
const SETTING_KEY = "capability_sandbox_agent";
const MARKER_MODEL = "claude-sonnet-5-harness-marker";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
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

async function setState(enabled: boolean, config: Record<string, unknown>) {
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: { enabled, config } },
    update: { value: { enabled, config } },
  });
}

async function main() {
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  const anthropic = await db.providerCredential.findFirst({ where: { provider: "anthropic_api" }, select: { id: true } });
  const admin = await db.user.create({
    data: { email: `sandbox-page-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const config = {
    credential: "subscription",
    ...(anthropic ? { credentialId: anthropic.id } : {}),
    model: MARKER_MODEL,
    effort: "high",
    maxTurns: 33,
    maxMinutes: 7,
    maxBudgetUsd: 4.5,
    steering: "",
  };

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(admin.email));
    const page = await ctx.newPage();

    // ---- OFF ----------------------------------------------------------------
    await setState(false, config);
    await page.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    const navOff = await page.locator("nav a", { hasText: "Sandbox" }).count();
    check("capability OFF: no Sandbox tab in the nav", navOff === 0);
    check("Tools shows the slim enable card", (await page.locator("[data-sandbox-enable-card]").count()) === 1);
    check("…without the full settings form (no Model field on Tools)", (await page.locator("text=Reasoning effort").count()) === 0);
    await page.goto(`${BASE}/admin/sandbox`, { waitUntil: "domcontentloaded" });
    check("/admin/sandbox bounces to Tools while OFF", /\/admin\/tools/.test(page.url()), page.url());

    // ---- flip ON from Tools (config must survive) -----------------------------
    await page.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    const card = page.locator("[data-sandbox-enable-card]");
    const box = card.locator("input[type=checkbox]");
    // Hydration race: re-click until React state reflects the change.
    for (let i = 0; i < 10 && !(await box.isChecked()); i++) {
      await box.click();
      await page.waitForTimeout(300);
    }
    await card.getByRole("button", { name: /save/i }).click();
    await page.waitForFunction(`document.body.innerText.includes("Capability enabled")`, undefined, { timeout: 15_000 });
    const after = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    const cfg = ((after?.value as { enabled?: boolean; config?: Record<string, unknown> }) ?? {});
    check("switch ON saved", cfg.enabled === true);
    check("…and the stored settings were NOT reset", cfg.config?.model === MARKER_MODEL && cfg.config?.maxTurns === 33, JSON.stringify(cfg.config).slice(0, 160));

    // ---- ON ---------------------------------------------------------------------
    await page.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    check("capability ON: Sandbox tab in the nav", (await page.locator("nav a", { hasText: "Sandbox" }).count()) >= 1);
    check("Tools card links to the Sandbox page", (await page.locator("[data-sandbox-enable-card] a[href='/admin/sandbox']").count()) === 1);
    await page.goto(`${BASE}/admin/sandbox`, { waitUntil: "domcontentloaded" });
    check("the Sandbox page renders", /\/admin\/sandbox$/.test(page.url()) && (await page.locator("h1, h2", { hasText: "Sandbox" }).count()) >= 1, page.url());
    check("service status shown", (await page.locator("[data-sandbox-service]").count()) === 1);
    // getByLabel with exact:true — `:has-text("Model")` is case-insensitive and
    // matched the API-key radio's "…model roles" blurb first (value "on").
    const modelValue = await page.getByLabel("Model", { exact: true }).inputValue().catch(() => "");
    check("configuration form shows the stored settings", modelValue === MARKER_MODEL, modelValue);
    check("no enable switch on the Sandbox page (it lives on Tools)", (await page.locator("text=Enable for this workspace").count()) === 0);
    check("plan usage panel present (subscription mode)", (await page.locator("text=Plan usage").count()) >= 1);
    check("fallback key picker present", (await page.locator("text=Fallback key").count()) >= 1);
    check('"What the agent reaches for" present', (await page.locator("text=What the agent reaches for").count()) >= 1);
    check("nav highlights the Sandbox tab", (await page.locator("nav a[aria-current='page']", { hasText: "Sandbox" }).count()) === 1);

    // ---- OFF again ----------------------------------------------------------------
    await setState(false, config);
    await page.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    check("OFF again: tab gone", (await page.locator("nav a", { hasText: "Sandbox" }).count()) === 0);
    await page.goto(`${BASE}/admin/sandbox`, { waitUntil: "domcontentloaded" });
    check("…and the page bounces", /\/admin\/tools/.test(page.url()));
  } finally {
    await browser.close();
    if (prior) await db.setting.update({ where: { key: SETTING_KEY }, data: { value: prior.value as object } });
    else await db.setting.deleteMany({ where: { key: SETTING_KEY } });
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
