/**
 * Live proof for the automatic temporary password (2026-09-09, owner ask:
 * "clients keep emailing me saying I can't log in, when they could just use
 * the fucking reset button").
 *
 *   TEST_BASE_URL=http://localhost:3000 node --import tsx \
 *     --loader ./scripts/shim-server-only.mjs --env-file=.env \
 *     scripts/test-never-signed-in.ts
 *
 * What it is: an account whose password has NEVER worked here, whose owner
 * fails a few times, is emailed a temporary password instead of being told
 * "invalid email or password" for ever. A reset LINK would not do — every
 * unused link on the estate had expired before anyone found it in quarantine.
 *
 * THE CHECK THAT MATTERS IS THE NEGATIVE ONE. Issuing a temporary password
 * REPLACES the account's current one, so if this ever fired for somebody who
 * merely mistyped, it would turn a typo into a lockout. Half of what follows
 * exists to prove it does not.
 *
 * SMTP is disabled for the run (restored in `finally`): the dev box has REAL
 * Zeptomail credentials and a harness must not put mail on the wire. That
 * exercises the "we couldn't send it" branch; the wording of the delivered
 * branch is pinned in `recovery-copy.test.ts`, which reads the source.
 */
import { chromium, type Browser } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const KNOWN = "ThePasswordTheyActuallyKnow!42";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function attemptSignIn(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Re-fill until React has hydrated — a fill that lands first changes the
  // DOM with no listener attached and the value never reaches state.
  for (let i = 0; i < 10; i++) {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    if ((await page.inputValue('input[name="email"]')) === email) break;
    await page.waitForTimeout(200);
  }
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1_500);
  const notice = await page.locator("[data-recovery-notice]").count();
  const text = (await page.textContent("body")) ?? "";
  await ctx.close();
  return { notice, text };
}

async function main() {
  const stamp = Date.now();
  const newcomer = `never-signed-in-${stamp}@example.test`;
  const regular = `signs-in-fine-${stamp}@example.test`;
  let smtp: { key: string; value: unknown } | null = null;
  let browser: Browser | undefined;

  try {
    // No mail on the wire from a test box. Restored in `finally`.
    const row = await db.setting.findUnique({ where: { key: "smtp" } });
    if (row) {
      smtp = { key: row.key, value: row.value };
      await db.setting.delete({ where: { key: "smtp" } });
    }

    const hash = await hashPassword(KNOWN);
    const a = await db.user.create({
      data: {
        email: newcomer,
        passwordHash: hash,
        role: "user",
        emailVerified: new Date(),
        lastSeenVersion: "9.9.9",
        lastSignInAt: null, // never got in — the whole point
      },
      select: { id: true, passwordHash: true },
    });
    const b = await db.user.create({
      data: {
        email: regular,
        passwordHash: hash,
        role: "user",
        emailVerified: new Date(),
        lastSeenVersion: "9.9.9",
        lastSignInAt: new Date(), // has signed in before
      },
      select: { id: true, passwordHash: true },
    });

    browser = await chromium.launch();

    // ---- the newcomer: two failures say nothing, the third offers help ----
    let r = await attemptSignIn(browser, newcomer, "wrong-1");
    check("1st failure offers nothing", r.notice === 0);
    r = await attemptSignIn(browser, newcomer, "wrong-2");
    check("2nd failure offers nothing", r.notice === 0);
    check("…and says only the ordinary thing", r.text.includes("Invalid email or password"));

    r = await attemptSignIn(browser, newcomer, "wrong-3");
    check("3rd failure raises the recovery notice", r.notice === 1);
    check(
      "…and explains it is the first use of the account",
      r.text.includes("first time this account has been used"),
      r.text.slice(0, 0),
    );

    const afterA = await db.user.findUnique({
      where: { id: a.id },
      select: { passwordHash: true, mustChangePassword: true, lastSignInAt: true },
    });
    check("the password was actually replaced", afterA?.passwordHash !== a.passwordHash);
    check("…and is marked one-shot, so it cannot stay live", afterA?.mustChangePassword === true);
    check("…and the account still reads as never signed in", afterA?.lastSignInAt === null);

    // ---- THE SAFETY CHECK: someone who HAS signed in is never touched ----
    for (const p of ["wrong-1", "wrong-2", "wrong-3", "wrong-4"]) {
      r = await attemptSignIn(browser, regular, p);
    }
    check("a returning user is NEVER offered this, however many times they fail", r.notice === 0);
    const afterB = await db.user.findUnique({
      where: { id: b.id },
      select: { passwordHash: true, mustChangePassword: true },
    });
    check(
      "…and their password is untouched — a typo must not become a lockout",
      afterB?.passwordHash === b.passwordHash && afterB?.mustChangePassword === false,
    );
    // Proof the harness can actually see a working sign-in on this account.
    const good = await attemptSignIn(browser, regular, KNOWN);
    check("…and they can still sign in with the password they know", !good.text.includes("Invalid email"));

    // ---- the throttle: trying again does not mint a second password ----
    const before = (await db.user.findUnique({ where: { id: a.id }, select: { passwordHash: true } }))!
      .passwordHash;
    await attemptSignIn(browser, newcomer, "wrong-4");
    await attemptSignIn(browser, newcomer, "wrong-5");
    const after = (await db.user.findUnique({ where: { id: a.id }, select: { passwordHash: true } }))!
      .passwordHash;
    check("further failures do not mint a second password inside the cooldown", after === before);

    // ---- and it is recorded where an admin would look -------------------
    const logged = await db.appLog.findFirst({
      where: { category: "auth", message: { contains: "temporary password" } },
      orderBy: { createdAt: "desc" },
      select: { message: true, details: true },
    });
    check(
      "the send is logged for the admin",
      !!logged && JSON.stringify(logged.details ?? {}).includes(newcomer),
      logged?.message ?? "no row",
    );
  } finally {
    await browser?.close().catch(() => {});
    await db.user.deleteMany({ where: { email: { in: [newcomer, regular] } } }).catch(() => {});
    if (smtp) {
      await db.setting
        .upsert({
          where: { key: "smtp" },
          create: { key: "smtp", value: smtp.value as never },
          update: { value: smtp.value as never },
        })
        .catch(() => {});
    }
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
