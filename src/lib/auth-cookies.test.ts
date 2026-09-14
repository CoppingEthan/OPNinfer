import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Several portals on one host share a cookie jar — cookies are scoped by host
 * and ignore the PORT. With the default Auth.js names, signing into
 * `10.0.0.10:3002` overwrote the session and CSRF token of `:3003`, so an
 * operator could never hold more than one portal open at a time (found live,
 * 2026-09-05, preparing three further instances on one host before their DNS
 * moved). Their own domains separate them in production, which is exactly why
 * this would rot unnoticed — so pin it here.
 *
 * Read from the SOURCE: the value depends on env that only exists in a
 * running container, and the failure mode (middleware and the routes deriving
 * DIFFERENT names) looks like being signed out on every request.
 */
describe("auth cookies are namespaced per instance", () => {
  const cfg = readFileSync("src/auth.config.ts", "utf8");

  it("names all three Auth.js cookies with the instance", () => {
    for (const c of ["sessionToken", "callbackUrl", "csrfToken"]) {
      expect(cfg).toMatch(new RegExp(`${c}:\\s*\\{`));
    }
    expect(cfg.match(/\$\{INSTANCE\}/g) ?? []).toHaveLength(3);
  });

  it("derives the instance from the env the container actually gets", () => {
    expect(cfg).toMatch(/process\.env\.OPNINFER_INSTANCE/);
    // Sanitised: the value lands in a cookie name.
    expect(cfg).toMatch(/replace\(\/\[\^a-z0-9-\]\/g, ""\)/);
  });

  it("ties Secure and the cookie prefixes to AUTH_URL, together", () => {
    // A Secure cookie over plain http is dropped, and __Host-/__Secure- are
    // only legal on a Secure cookie — so these must move as one.
    expect(cfg).toMatch(/const SECURE = \(process\.env\.AUTH_URL \?\? ""\)\.startsWith\("https:\/\/"\)/);
    expect(cfg).toMatch(/SECURE \? "__Secure-" : ""/);
    expect(cfg).toMatch(/SECURE \? "__Host-" : ""/);
    expect(cfg).toMatch(/secure: SECURE/);
  });

  it("the admin sudo grant is namespaced too", () => {
    const sudo = readFileSync("src/lib/sudo.ts", "utf8");
    expect(sudo).toMatch(/opninfer_sudo_\$\{/);
    expect(sudo).toMatch(/process\.env\.OPNINFER_INSTANCE/);
  });
});
