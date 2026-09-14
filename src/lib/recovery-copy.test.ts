import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The words on the login screen, pinned from SOURCE.
 *
 * The delivered branch cannot be exercised on the dev box — `test-never-signed-
 * in.ts` disables SMTP so a harness never puts mail on the wire, which leaves
 * the "we couldn't send it" wording covered and this one not. And the line
 * that matters most is exactly the one nothing else would catch: the owner's
 * whole reason for the feature is that these emails are sitting in spam and
 * quarantine folders, so a notice that fails to say where to look does the
 * user no good at all.
 */
describe("the recovery notice", () => {
  const form = readFileSync("src/app/login/login-form.tsx", "utf8");
  const action = readFileSync("src/app/actions/auth.ts", "utf8");

  it("tells them WHERE the email actually is", () => {
    expect(form).toMatch(/spam and quarantine/i);
  });

  it("says the password does not expire — the reason it beats a reset link", () => {
    // Every unused reset link on the estate had expired before anyone found
    // it. If this promise disappears, the feature loses its point.
    expect(form).toMatch(/does not expire/i);
  });

  it("explains WHY they are seeing it, so it does not read as an error", () => {
    expect(form).toMatch(/first time this account has been used/i);
  });

  it("has an honest branch for when the send fails", () => {
    // The password has already been replaced by then — telling them nothing
    // would leave them locked out with no idea why.
    // JSX wraps this line, so match across the break rather than on one line.
    expect(form.replace(/\s+/g, " ")).toMatch(/couldn(&apos;|')t send the email/i);
    expect(form).toMatch(/ask your administrator/i);
  });

  it("only ever fires for an account that has never signed in", () => {
    // The load-bearing guard. Issuing a password REPLACES the current one.
    expect(action).toMatch(/shouldIssueRecoveryPassword/);
    expect(action).toMatch(/lastSignInAt: user\?\.lastSignInAt \?\? null/);
  });

  it("never reveals whether an address has an account", () => {
    // Every ineligible path must fall through to the same generic message.
    expect(action).toMatch(/return \{ error: "Invalid email or password, or your account is inactive\." \}/);
  });
});
