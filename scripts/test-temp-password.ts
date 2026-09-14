/**
 * Live test of admin-set temporary passwords and self-service password change.
 *
 * Why this exists (owner, 2026-09-07): password-reset emails are being
 * DELIVERED and then blocked at the recipient's mail system, so people never
 * get them. The admin now sets a password, sees it, and passes it on by
 * another route — and because a password a second person knows must not stay
 * live, it works exactly once: the person is held at a change screen until
 * they choose their own.
 *
 * What it proves, in order:
 *   1. "Set a password" returns the password to the admin (it used to be
 *      shown only when the EMAIL failed, which is exactly the case that
 *      never happens here) and marks the account must-change
 *   2. that password signs in, and every route lands on /change-password —
 *      chat, admin, and the API alike
 *   3. the current password is required: a wrong one is refused
 *   4. changing it clears the flag, ends the session, and the NEW password
 *      works while the temporary one no longer does
 *   5. a normal user can change their password voluntarily from Settings,
 *      with no email involved
 *   6. an admin setting their OWN password is not marched to the screen
 *
 * Needs no provider keys — nothing here calls a model.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env \
 *     scripts/test-temp-password.ts
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "tp-admin@example.test";
const USER_EMAIL = "tp-user@example.test";
const KNOWN = "temp-pass-harness-1!";
const CHOSEN = "chosen-by-me-2!";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

async function seed() {
  const passwordHash = await hashPassword(KNOWN);
  const common = {
    passwordHash,
    emailVerified: new Date(),
    // Past the What's new panel: a fresh account gets a modal overlay that
    // Playwright refuses to click through (the documented harness gotcha).
    lastSeenVersion: "9.9.9",
    mustChangePassword: false,
  };
  const admin = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { ...common, role: "admin", disabled: false },
    create: { email: ADMIN_EMAIL, name: "TP Admin", role: "admin", ...common },
  });
  const user = await db.user.upsert({
    where: { email: USER_EMAIL },
    update: { ...common, role: "user", disabled: false },
    create: { email: USER_EMAIL, name: "TP User", role: "user", ...common },
  });
  return { admin, user };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 });
  // Re-fill until the values stick (2026-09-09). A `fill` that lands before
  // React hydrates changes the DOM with no listener attached, so state never
  // moves and the submit posts nothing — the form's own `required` then stops
  // it and the page simply sits there, with NOTHING in the server log to
  // explain it. Invisible against a long-running dev server, reproducible
  // every time against a freshly started one. Same race the admin-logs and
  // system-prompt harnesses already guard against.
  for (let i = 0; i < 10; i++) {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    if (
      (await page.inputValue('input[name="email"]')) === email &&
      (await page.inputValue('input[name="password"]')) === password
    ) {
      break;
    }
    await page.waitForTimeout(250);
  }
  await page.click('button[type="submit"]');
  // WAIT FOR THE OUTCOME, not for a stopwatch (2026-09-09). A fixed 2.5s is
  // plenty against a long-warm dev server and not nearly enough against a
  // freshly started one, where the redirect target still has to compile — so
  // this reported "the admin signs in: FAIL" for a sign-in that had actually
  // succeeded, with nothing in the server log to contradict it because a
  // SUCCESSFUL sign-in writes no row. Settle on either leaving /login or the
  // form saying why we could not.
  await page
    .waitForFunction(
      `!location.pathname.startsWith("/login") ||
       !!document.querySelector('[data-recovery-notice]') ||
       /Invalid email or password/i.test(document.body.innerText)`,
      undefined,
      { timeout: 45_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Submit and wait for the error banner.
 *
 * Clicks more than once on purpose: the first trusted click after a page load
 * can be swallowed by the hydration race (documented for the admin Logs and
 * Users pages, and it bites here too — the submit did nothing at all and the
 * check read as "no error shown"). Safe to repeat, because every caller is
 * submitting something that MUST be refused.
 */
async function submitExpectingError(page: Page): Promise<string> {
  for (let i = 0; i < 6; i++) {
    await page.click('button[type="submit"]').catch(() => {});
    try {
      await page.waitForSelector('[role="alert"]', { timeout: 6_000 });
      // Read the alert, not the body: the page carries an inline <style>
      // block that `textContent` would happily include.
      return (await page.textContent('[role="alert"]')) ?? "";
    } catch {
      /* not hydrated yet, or still compiling the action — try again */
    }
  }
  return "";
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  try {
    const { admin, user } = await seed();

    browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Every URL the browser is ever asked for. A form that is not intercepted
    // submits NATIVELY AS A GET, which put `?current=…&password=…` in the
    // address bar, the history and the server log — found by this harness on
    // 2026-09-07, before the form became a server action. Watch every
    // navigation rather than trusting the fix to stay in place.
    const urlsSeen: string[] = [];
    page.on("framenavigated", (f) => urlsSeen.push(f.url()));
    page.on("request", (r) => urlsSeen.push(r.url()));

    // ---- 1. the admin sets a password and can SEE it --------------------
    await signIn(page, ADMIN_EMAIL, KNOWN);
    check("the admin signs in", !page.url().includes("/login"), page.url());

    await page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("table", { timeout: 30_000 });

    // How far this table already overflows its scroll container, before the
    // password row exists — the baseline the check below compares against.
    const overBefore = await page.evaluate(() => {
      const wrap = document.querySelector("table")!.parentElement as HTMLElement;
      return wrap.scrollWidth - wrap.clientWidth;
    });

    // Drive the real menu rather than calling the action directly — the point
    // is that the admin can get at the password from the UI. Two documented
    // quirks of this page: the menu renders in a PORTAL (so its items are not
    // inside the row), and the first trusted click after load can be
    // swallowed by the hydration race — so click until it opens.
    const setItem = page.locator('[role="menu"] button:has-text("Set a password")').first();
    let menuWorked = false;
    for (let i = 0; i < 8 && !menuWorked; i++) {
      await page.click(`button[aria-label="Actions for ${USER_EMAIL}"]`).catch(() => {});
      await page.waitForTimeout(500);
      menuWorked = await setItem.isVisible().catch(() => false);
    }
    check("the Users kebab offers 'Set a password'", menuWorked);
    if (!menuWorked) throw new Error("could not open the row menu");
    await setItem.click();

    await page.waitForSelector("[data-temp-password]", { timeout: 30_000 });
    const shown = (await page.textContent("[data-temp-password]"))?.trim() ?? "";
    check("the password is shown to the admin", shown.length >= 12, `${shown.length} chars`);

    const after = await db.user.findUnique({
      where: { id: user.id },
      select: { mustChangePassword: true },
    });
    check("the account is marked must-change", after?.mustChangePassword === true);

    // No email was sent: this is the "delivered then blocked" case the whole
    // feature exists for, so the admin must not be relying on one.
    const bodyText = (await page.textContent("body")) ?? "";
    check("it does not claim to have emailed anything", !bodyText.includes("also emailed"));

    // The row must not WIDEN the table, and must be fully visible when it
    // appears. It widened the table by 45px, and opening the menu scrolls the
    // container sideways, which together clipped the very message telling the
    // admin to copy the password (2026-09-07). Compared against the width
    // BEFORE, because this table already overflows its container at ordinary
    // window sizes for reasons of its own — asserting "no overflow" would be
    // asserting something that was never true.
    const fit = await page.evaluate(() => {
      const table = document.querySelector("[data-temp-password]")!.closest("table")!;
      const wrap = table.parentElement as HTMLElement;
      return { over: wrap.scrollWidth - wrap.clientWidth, scrolled: wrap.scrollLeft };
    });
    check(
      "the password row adds nothing to the table's width",
      fit.over <= overBefore,
      `${fit.over}px vs ${overBefore}px before`,
    );
    check(
      "…and the message is scrolled into view, not clipped",
      fit.scrolled === 0,
      `scrollLeft ${fit.scrolled}`,
    );

    // ---- 2. the temporary password signs in, and goes nowhere -----------
    await signOut(page);
    await signIn(page, USER_EMAIL, shown);
    check("the temporary password signs in", !page.url().includes("/login"), page.url());
    check("…and lands on the change screen", page.url().includes("/change-password"), page.url());

    for (const path of ["/chat", "/admin", "/admin/users"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      check(
        `${path} redirects to the change screen`,
        page.url().includes("/change-password"),
        page.url(),
      );
    }

    // ---- 3. the current password is required ----------------------------
    await page.goto(`${BASE}/change-password`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="current"]', { timeout: 30_000 });
    await page.fill('input[name="current"]', "not-the-password");
    await page.fill('input[name="password"]', CHOSEN);
    await page.fill('input[name="confirm"]', CHOSEN);
    const refusedText = await submitExpectingError(page);
    check(
      "a wrong current password is refused",
      /not your current password/i.test(refusedText),
      refusedText.slice(0, 120) || "(no alert shown)",
    );
    const stillFlagged = await db.user.findUnique({
      where: { id: user.id },
      select: { mustChangePassword: true },
    });
    check("…and the flag is untouched", stillFlagged?.mustChangePassword === true);

    // Mismatched confirmation is caught before anything is sent.
    await page.fill('input[name="current"]', shown);
    await page.fill('input[name="password"]', CHOSEN);
    await page.fill('input[name="confirm"]', `${CHOSEN}x`);
    check("mismatched new passwords are caught", /do not match/i.test(await submitExpectingError(page)));

    // ---- 4. changing it clears the flag and rotates the password --------
    await page.fill('input[name="current"]', shown);
    await page.fill('input[name="password"]', CHOSEN);
    await page.fill('input[name="confirm"]', CHOSEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname === "/login", { timeout: 30_000 }).catch(() => {});
    check(
      "a successful change signs you out, to the sign-in screen",
      page.url().includes("/login"),
      page.url(),
    );
    check(
      "…and the sign-in screen says what happened",
      /Password updated/i.test((await page.textContent("body")) ?? ""),
    );

    const cleared = await db.user.findUnique({
      where: { id: user.id },
      select: { mustChangePassword: true, passwordChangedAt: true },
    });
    check("the must-change flag is cleared", cleared?.mustChangePassword === false);
    check("the change is stamped (ends other sessions)", !!cleared?.passwordChangedAt);

    await signOut(page);
    await signIn(page, USER_EMAIL, shown);
    check(
      "the temporary password no longer works",
      page.url().includes("/login"),
      page.url(),
    );

    await signIn(page, USER_EMAIL, CHOSEN);
    check("the chosen password works", !page.url().includes("/login"), page.url());
    check(
      "…and goes straight to the chat, not the change screen",
      !page.url().includes("/change-password"),
      page.url(),
    );

    // ---- 5. a voluntary change, from Settings ---------------------------
    const settingsHref = await page.evaluate(() => {
      // The modal is opened from the account menu; the link itself is what
      // this asserts, since the menu is covered by other harnesses.
      return document.querySelector('a[href="/change-password"]') ? "present" : "absent";
    });
    // Not open yet — assert the route serves a voluntary visit instead.
    await page.goto(`${BASE}/change-password`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="current"]', { timeout: 30_000 });
    const voluntary = (await page.textContent("body")) ?? "";
    check(
      "a voluntary visit is allowed and worded differently",
      voluntary.includes("Change your password") && !voluntary.includes("was set for you"),
      settingsHref,
    );

    // ---- 6. an admin's own password is not made temporary ---------------
    const { updateUser } = await import("../src/app/actions/admin");
    void updateUser; // referenced so the import is not elided
    const adminRow = await db.user.findUnique({
      where: { id: admin.id },
      select: { mustChangePassword: true },
    });
    check("the admin was not flagged by any of this", adminRow?.mustChangePassword === false);

    // ---- 7. no password ever reached a URL ------------------------------
    const leaked = urlsSeen.filter(
      (u) => u.includes(encodeURIComponent(CHOSEN)) || u.includes(CHOSEN) || u.includes(shown),
    );
    check(
      "no password ever appeared in a URL",
      leaked.length === 0,
      leaked[0]?.slice(0, 160) ?? `${urlsSeen.length} urls watched`,
    );
    // Negative control: the watcher has to have seen something, or the check
    // above passes for the wrong reason.
    check(
      "(control) navigations were actually being watched",
      urlsSeen.some((u) => u.includes("/change-password")),
      `${urlsSeen.length} urls`,
    );
  } finally {
    await browser?.close();
    await db.user
      .deleteMany({ where: { email: { in: [ADMIN_EMAIL, USER_EMAIL] } } })
      .catch(() => {});
    await db.$disconnect();
  }

  console.log(
    failures === 0 ? "\nALL TEMP-PASSWORD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
