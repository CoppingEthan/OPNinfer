import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Admin-set temporary passwords (2026-09-07).
 *
 * Password-reset emails are being delivered to the recipient's mail system
 * and blocked there, so the operator now sets a password, sees it, and passes
 * it on another way. A password a second person knows must not stay live, so
 * it works exactly once: the account is flagged and every route leads to the
 * change screen until they choose their own.
 *
 * Read from the SOURCE, like `auth-cookies.test.ts`: these rules live in
 * middleware (edge, no database), in the Auth.js callbacks, and in a form's
 * shape — none of which can be executed here. `scripts/test-temp-password.ts`
 * proves the behaviour end to end; this is what stops a quiet edit undoing it.
 */
describe("temporary passwords", () => {
  const mw = readFileSync("src/middleware.ts", "utf8");
  const auth = readFileSync("src/auth.ts", "utf8");
  const admin = readFileSync("src/app/actions/admin.ts", "utf8");
  // The mechanics moved into a module shared with the login screen's
  // automatic offer (2026-09-09) — the RULES about what a temporary password
  // is now live there, and must keep holding wherever they are read from.
  const temp = readFileSync("src/lib/temp-password.ts", "utf8");
  const profile = readFileSync("src/app/actions/profile.ts", "utf8");
  const form = readFileSync("src/app/change-password/change-password-form.tsx", "utf8");

  it("middleware sends a flagged session to the change screen, and nowhere else", () => {
    expect(mw).toMatch(/const CHANGE_PASSWORD = "\/change-password"/);
    expect(mw).toMatch(
      /req\.auth\?\.user\?\.mustChangePassword && path !== CHANGE_PASSWORD[\s\S]{0,120}redirect/,
    );
  });

  it("the flag is RE-READ on the session recheck, not just carried", () => {
    // Otherwise setting a temporary password would not touch a session that
    // is already open, and clearing it would leave the person stuck on the
    // change screen for the rest of the token's seven days.
    expect(auth).toMatch(/mustChangePassword: true,/); // in the recheck select
    expect(auth).toMatch(/token\.mustChangePassword = row\.mustChangePassword/);
  });

  it("an admin-set password is always returned AND marked temporary", () => {
    // It used to be shown only when the email FAILED — which is exactly the
    // case that never happens here, since the mail is delivered and then
    // blocked at the far end.
    expect(admin).toMatch(/return \{ emailed: delivered, password, email: user\.email \}/);
    expect(temp).toMatch(/mustChangePassword: true,/);
    // And it can skip the email entirely.
    expect(temp).toMatch(/opts\.sendEmail !== false/);
    // A send that throws must not throw out of the issuer: the password has
    // already been replaced by then, so the caller has to be told, not
    // handed an exception that loses the fact entirely.
    expect(temp).toMatch(/catch \{\s*emailed = false;/);
  });

  it("an admin setting their OWN password is not marched to the screen", () => {
    expect(admin).toMatch(/data\.mustChangePassword = userId !== admin\.id/);
  });

  it("changing a password clears the flag and ends the session", () => {
    expect(profile).toMatch(/mustChangePassword: false/);
    expect(profile).toMatch(/passwordChangedAt: new Date\(\)/);
    expect(profile).toMatch(/signOut\(\{ redirectTo: "\/login\?reset=1" \}\)/);
  });

  it("the current password is required, even on the forced screen", () => {
    expect(profile).toMatch(/verifyPassword\(user\.passwordHash, current\)/);
  });

  it("the change form is a FORM ACTION, never an intercepted submit", () => {
    // THE BUG this pins (found live, 2026-09-07): with an `onSubmit` handler,
    // a click that lands before React hydrates makes the browser submit
    // natively — as a GET — putting `?current=…&password=…` into the address
    // bar, the browser history and the server log. A form action is a POST
    // whether or not the page has hydrated.
    expect(form).toMatch(/<form action=\{formAction\}/);
    expect(form).not.toMatch(/onSubmit=/);
    expect(form).not.toMatch(/method="get"/i);
  });
});
