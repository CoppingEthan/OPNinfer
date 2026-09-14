/**
 * Live browser harness — "New chat" from an open chat must show an empty
 * composer, not the old thread (owner bug, 2026-09-02, production).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-new-chat-nav.ts
 *
 * No model calls: the chat is seeded in the DB. Opens /chat/<id>, clicks the
 * sidebar's New chat, and checks the URL AND the view both moved — the bug
 * was the URL changing to /chat while the thread stayed on screen until a
 * refresh. Also checks the reverse (open an existing chat from the new-chat
 * screen) and a second round trip.
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
const PASSWORD = "new-chat-nav-1!";

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

async function main() {
  // Against a REMOTE instance (TEST_BASE_URL + TEST_EMAIL + TEST_CONV_ID), the
  // user and seeded chat are created there beforehand and this touches no DB.
  const remote = !!process.env.TEST_EMAIL;
  const user = remote
    ? { id: "", email: process.env.TEST_EMAIL as string }
    : await db.user.create({
        data: { email: `new-chat-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
      });
  const convo = remote
    ? { id: process.env.TEST_CONV_ID as string }
    : await db.conversation.create({
        data: {
          userId: user.id,
          title: "🧪 Seeded chat",
          messages: {
            create: [
              { role: "user", content: "SEEDED-QUESTION-MARKER what is two plus two?" },
              { role: "assistant", content: "SEEDED-ANSWER-MARKER Four." },
            ],
          },
        },
      });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    // Log Next's client-navigation fetches (RSC payloads): a proxy/CDN that
    // caches these by URL alone hands the router the wrong thing and the
    // URL moves while the view does not.
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.searchParams.has("_rsc") || (r.request().headers()["rsc"] === "1")) {
        const h = r.headers();
        console.log(`  [rsc] ${r.status()} ${u.pathname}${u.search.slice(0, 20)} type=${h["content-type"]} cache=${h["cf-cache-status"] ?? h["x-cache"] ?? "-"} age=${h["age"] ?? "-"} vary=${h["vary"] ?? "-"} cc=${h["cache-control"] ?? "-"}`);
      }
    });

    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    check("seeded chat renders its messages", (await page.locator("text=SEEDED-ANSWER-MARKER").count()) === 1);

    // Click the sidebar's New chat (a link or button labelled "New chat").
    const newChat = page.locator("a:has-text('New chat'), button:has-text('New chat')").first();
    await newChat.waitFor({ state: "visible", timeout: 10_000 });
    await newChat.click();
    await page.waitForURL((u) => /\/chat\/?$/.test(u.pathname), { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    check("URL moved to /chat", /\/chat\/?$/.test(new URL(page.url()).pathname), page.url());
    const staleBubbles = await page.locator("text=SEEDED-ANSWER-MARKER").count();
    check("the old thread is GONE from the screen (no refresh)", staleBubbles === 0, `${staleBubbles} stale bubble(s) still visible`);
    check("an empty composer is shown", (await page.locator("textarea").count()) === 1);
    check("the empty-chat greeting/footer is shown", (await page.locator("text=/v0\\.\\d+\\.\\d+|How can I help/i").count()) >= 1);

    // Reverse: open the seeded chat from the sidebar, then New chat again.
    await page.locator(`a[href='/chat/${convo.id}']`).first().click();
    await page.waitForTimeout(800);
    check("opening the chat from the sidebar shows it again", (await page.locator("text=SEEDED-ANSWER-MARKER").count()) === 1);
    await page.locator("a:has-text('New chat'), button:has-text('New chat')").first().click();
    await page.waitForTimeout(800);
    check("second New chat also clears the view", (await page.locator("text=SEEDED-ANSWER-MARKER").count()) === 0);
  } finally {
    await browser.close();
    if (!remote) {
      await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    }
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
