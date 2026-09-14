/**
 * Visual probe — screenshot the generated-file cards (owner ask 2026-09-02:
 * Claude.ai's look). Seeds a reply with three presented files (no model
 * calls), screenshots the bubble in light and dark, writes
 * logs/file-cards-{light,dark}.png, cleans up.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/shot-file-cards.ts
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
const PASSWORD = "shot-cards-1!";

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
  const user = await db.user.create({
    data: { email: `shot-cards-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "🧪 Cards" } });
  const mk = (filename: string, mimeType: string, sizeBytes: number) =>
    db.file.create({
      data: {
        conversationId: convo.id,
        userId: user.id,
        filename,
        mimeType,
        sizeBytes,
        storagePath: `default/chats/${convo.id}/${filename}`,
        kind: "generated",
        status: "ready",
      },
    });
  const files = [
    await mk("pr-property-email-signature.html", "text/html", 4210),
    await mk("README-how-to-install-the-signature.txt", "text/plain", 812),
    await mk("q3-sales-summary.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 18211),
    await mk("assets-bundle.zip", "application/zip", 220100),
    await mk("config.json", "application/json", 900),
  ];
  const ids = files.map((f) => f.id);
  await db.message.createMany({
    data: [
      { conversationId: convo.id, role: "user", content: "Build me the email signature files." },
      {
        conversationId: convo.id,
        role: "assistant",
        content: "Here are your files — the signature, the install notes, and the summary sheet.\n\nLet me know what to change.",
        meta: {
          fileIds: ids,
          activity: [
            { kind: "status", label: "Working in the Sandbox: “Build the signature…”", at: 0 },
            { kind: "files", ids, at: 78 },
          ],
        },
      },
    ],
  });

  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await ctx.addCookies(await signIn(user.email));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
      await page.evaluate(`document.documentElement.classList.${theme === "dark" ? "add" : "remove"}("dark")`);
      await page.waitForTimeout(1200); // entrance animation settles
      const bubble = page.locator("[data-role='assistant']").last();
      await bubble.screenshot({ path: `logs/file-cards-${theme}.png` });
      // Hover the first card and catch the icon mid-animation.
      await page.locator("[data-file-card]").first().hover();
      await page.waitForTimeout(200);
      await bubble.screenshot({ path: `logs/file-cards-${theme}-hover.png` });
      const anim = await page.evaluate("getComputedStyle(document.querySelector('[data-file-card] [class*=\"oi-fc-\"]')).animationName");
      console.log(`  hover animation on the first icon: ${anim}`);
      await page.mouse.move(0, 0);
      // Open the caret menu on the first card for a second shot.
      await page.locator("[data-file-card] button[aria-label='More options']").first().click();
      await page.waitForTimeout(250);
      await bubble.screenshot({ path: `logs/file-cards-${theme}-menu.png` });
      await ctx.close();
      console.log(`wrote logs/file-cards-${theme}.png (+ -menu)`);
    }
  } finally {
    await browser.close();
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
