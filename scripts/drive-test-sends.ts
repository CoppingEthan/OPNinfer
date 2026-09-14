/**
 * Drive the three "send test" buttons on the LIVE site with a throwaway admin
 * (created beforehand on the VM; TEST_EMAIL/TEST_PASSWORD in env). The mails
 * go to the instance's configured alert / report addresses, not to the
 * throwaway account. Prints each button's result line.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.TEST_BASE_URL ?? "https://chat.acme.example";
const EMAIL = process.env.TEST_EMAIL!;
const PASSWORD = process.env.TEST_PASSWORD!;

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

async function main() {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    await ctx.addCookies(await signIn(EMAIL));
    const page = await ctx.newPage();

    // 1 + 2: plan alerts from Admin → Sandbox
    await page.goto(`${BASE}/admin/sandbox`, { waitUntil: "domcontentloaded" });
    for (const label of ["Send test: 90% warning", "Send test: limit reached"]) {
      const btn = page.getByRole("button", { name: label });
      await btn.waitFor({ state: "visible", timeout: 20_000 });
      // Hydration race: click until a result line appears.
      for (let i = 0; i < 6; i++) {
        await btn.click();
        try {
          await page.waitForFunction(`/(alert sent to|Failed|No SMTP|No alert address|couldn't)/i.test(document.body.innerText)`, undefined, { timeout: 12_000 });
          break;
        } catch { /* retry */ }
      }
      const line = (await page.locator("text=/alert sent to|Failed|No SMTP|No alert address/i").first().innerText().catch(() => "(no result line)"));
      console.log(`${label} → ${line}`);
      await page.waitForTimeout(800);
    }

    // 3: weekly report from Admin → SMTP
    await page.goto(`${BASE}/admin/smtp`, { waitUntil: "domcontentloaded" });
    const send = page.getByRole("button", { name: /send one now/i });
    await send.waitFor({ state: "visible", timeout: 20_000 });
    for (let i = 0; i < 6; i++) {
      await send.click();
      try {
        await page.waitForFunction(`/(report sent to|Failed|No SMTP|valid email)/i.test(document.body.innerText)`, undefined, { timeout: 30_000 });
        break;
      } catch { /* retry */ }
    }
    const line = await page.locator("text=/report sent to|Failed|No SMTP|valid email/i").first().innerText().catch(() => "(no result line)");
    console.log(`Send one now (weekly report) → ${line}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
