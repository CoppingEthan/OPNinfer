/**
 * Browser-level test of Admin → Chats (owner ask, 2026-07-29): an admin can
 * read any user's conversation for support, but only after re-entering their
 * OWN password, and every chat opened is recorded against their account.
 *
 *  1. Locked by default — no titles leak before unlocking.
 *  2. A wrong password is refused; the list stays locked.
 *  3. The right password unlocks the list, which shows another user's chat.
 *  4. Opening it renders the full thread (both sides of the conversation).
 *  5. The access is written to the audit log with admin + owner + chat id.
 *  6. Incognito chats never appear.
 *  7. "Lock now" re-locks immediately.
 *  8. A non-admin cannot reach the page at all.
 *
 * Needs no provider keys — the fixture conversation is inserted directly.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-admin-chats.ts
 */
import { chromium, type BrowserContext } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ADMIN_PASSWORD = "chats-admin-1!";
const USER_PASSWORD = "chats-user-1!";
const STAMP = Date.now();

const USER_TEXT = `Why did my export fail? (fixture ${STAMP})`;
const ASSISTANT_TEXT = `Because the file was still processing. (fixture ${STAMP})`;
const SECRET_TITLE = `Incognito fixture ${STAMP}`;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
  );
  if (!ok) failures++;
}

/** Log in over the credentials endpoint and return a cookie-primed context. */
async function signIn(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  email: string,
  password: string,
): Promise<BrowserContext> {
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
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
  });
  await ctx.addCookies(
    [...jar].map(([name, value]) => ({ name, value, url: BASE })),
  );
  return ctx;
}

async function main() {
  const adminEmail = `chats-admin-${STAMP}@example.test`;
  const ownerEmail = `chats-owner-${STAMP}@example.test`;

  const admin = await db.user.create({
    data: {
      email: adminEmail,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  const owner = await db.user.create({
    data: {
      email: ownerEmail,
      name: "Fixture Owner",
      passwordHash: await hashPassword(USER_PASSWORD),
      role: "user",
      emailVerified: new Date(),
    },
  });

  const convo = await db.conversation.create({
    data: {
      userId: owner.id,
      title: `Export problem ${STAMP}`,
      messages: {
        create: [
          { role: "user", content: USER_TEXT },
          {
            role: "assistant",
            content: ASSISTANT_TEXT,
            model: "claude-sonnet-5",
            provider: "anthropic-api",
          },
        ],
      },
    },
  });
  const incognito = await db.conversation.create({
    data: { userId: owner.id, title: SECRET_TITLE, incognito: true },
  });

  const browser = await chromium.launch();
  try {
    const ctx = await signIn(browser, adminEmail, ADMIN_PASSWORD);
    const page = await ctx.newPage();

    // --- 1. Locked by default -------------------------------------------
    await page.goto(`${BASE}/admin/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("input[type=password]", { timeout: 20_000 });
    let body = await page.locator("body").innerText();
    check("locked: password gate is shown", /confirm it.s you/i.test(body), body.slice(0, 120));
    check("locked: no chat titles leak", !body.includes(convo.title));

    // --- 2. Wrong password is refused ------------------------------------
    await page.fill("input[type=password]", "definitely-not-the-password");
    await page.click("button[type=submit]");
    await page.waitForSelector("[role=alert]", { timeout: 20_000 });
    body = await page.locator("body").innerText();
    check("wrong password is rejected", /not correct/i.test(body));
    check("wrong password leaves it locked", !body.includes(convo.title));

    // --- 3. Correct password unlocks -------------------------------------
    await page.fill("input[type=password]", ADMIN_PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForSelector("table", { timeout: 20_000 });
    body = await page.locator("body").innerText();
    check("unlocked: the other user's chat is listed", body.includes(convo.title));
    check("unlocked: the owner is named", /Fixture Owner/.test(body));
    check("unlocked: banner warns the access is logged", /logged against your account/i.test(body));

    // --- 6. Incognito never appears --------------------------------------
    check("incognito chat is not listed", !body.includes(SECRET_TITLE));

    // --- 4. The transcript renders both sides ----------------------------
    await page.click(`text=${convo.title}`);
    await page.waitForSelector("[data-role='assistant']", { timeout: 20_000 });
    const transcript = await page.locator("body").innerText();
    check("transcript shows the user's message", transcript.includes(USER_TEXT));
    check("transcript shows the assistant's reply", transcript.includes(ASSISTANT_TEXT));
    // Rendered with the REAL chat bubble, so an admin sees the user's view.
    check(
      "renders the user turn with the chat component",
      (await page.locator("[data-role='user']").count()) === 1,
    );
    // Read-only falls out of passing no handlers — assert each mutating
    // control is genuinely absent rather than merely inert.
    check(
      "transcript has no composer (read-only)",
      (await page.locator("textarea").count()) === 0,
    );
    check(
      "no rating buttons",
      (await page.locator("[aria-label='Good response'], [aria-label='Bad response']").count()) === 0,
    );
    check("no retry button", (await page.locator("[aria-label='Retry']").count()) === 0);
    check("no edit button", (await page.locator("[aria-label='Edit message']").count()) === 0);
    check(
      "copy is still available",
      (await page.locator("[aria-label='Copy']").count()) > 0,
    );

    // --- 5. The access is audited ----------------------------------------
    const entry = await db.auditLog.findFirst({
      where: { action: "admin.view_chat", userId: admin.id },
      orderBy: { createdAt: "desc" },
    });
    const details = entry?.details as { conversationId?: string; ownerEmail?: string } | null;
    check("audit row written for the view", !!entry);
    check("audit row names the conversation", details?.conversationId === convo.id, details?.conversationId ?? "—");
    check("audit row names the owner", details?.ownerEmail === ownerEmail, details?.ownerEmail ?? "—");

    const unlockEntry = await db.auditLog.findFirst({
      where: { action: "admin.chats_unlock", userId: admin.id },
    });
    check("audit row written for the unlock", !!unlockEntry);

    // --- 7. Lock now re-locks --------------------------------------------
    await page.goto(`${BASE}/admin/chats`, { waitUntil: "domcontentloaded" });
    await page.click("text=Lock now");
    await page.waitForSelector("input[type=password]", { timeout: 20_000 });
    body = await page.locator("body").innerText();
    check("lock now returns the gate", /confirm it.s you/i.test(body));
    check("lock now hides the titles again", !body.includes(convo.title));

    // --- 8. A non-admin cannot reach it ----------------------------------
    const userCtx = await signIn(browser, ownerEmail, USER_PASSWORD);
    const userPage = await userCtx.newPage();
    await userPage.goto(`${BASE}/admin/chats`, { waitUntil: "domcontentloaded" });
    check(
      "non-admin is bounced off /admin/chats",
      !userPage.url().includes("/admin"),
      userPage.url(),
    );
    await userCtx.close();
    await ctx.close();
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: { in: [convo.id, incognito.id] } } });
    await db.auditLog.deleteMany({ where: { userId: admin.id } });
    await db.user.deleteMany({ where: { id: { in: [admin.id, owner.id] } } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
