import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two halves of the image must not leak into each other.
 *
 * A PORTAL holds one client's data and must never serve the operator console;
 * the CONSOLE has no database of its own, so a portal route there would fail
 * in confusing ways at best. Both are enforced in middleware, which is exactly
 * the kind of file whose matcher and branches get edited for other reasons —
 * and neither failure has a symptom you would go looking for (a portal quietly
 * serving `/console` looks like nothing at all until someone finds it).
 *
 * Read from the SOURCE, like `auth-cookies.test.ts` and
 * `standalone-trace.test.ts`: the behaviour depends on env that only exists in
 * a running container, so there is nothing to execute here.
 */
describe("portal and console stay separate", () => {
  const mw = readFileSync("src/middleware.ts", "utf8");

  it("middleware decides on the build-time mode flag", () => {
    expect(mw).toMatch(/import \{ IS_CONSOLE \} from "@\/lib\/mode"/);
  });

  it("a portal 404s the console tree", () => {
    // Not a redirect: there is nothing at that address on that container.
    expect(mw).toMatch(/if \(isConsolePath\) return new NextResponse\(null, \{ status: 404 \}\)/);
  });

  it("the console 404s everything that is not its own", () => {
    expect(mw).toMatch(
      /if \(path !== "\/" && !isConsolePath && path !== "\/login"\)[\s\S]{0,80}status: 404/,
    );
  });

  it("the console still requires a session", () => {
    const consoleBranch = mw.slice(mw.indexOf("if (IS_CONSOLE) {"), mw.indexOf("// A portal:"));
    expect(consoleBranch).toMatch(/if \(!isLoggedIn\)/);
    expect(consoleBranch).toMatch(/redirect\(loginUrl\)/);
  });

  it("the console's API routes are covered by the console prefix list", () => {
    expect(mw).toMatch(/CONSOLE_PREFIXES = \["\/console", "\/api\/console"\]/);
  });

  it("mode is env-only, so middleware's edge bundle stays clean", () => {
    // `lib/mode.ts` is imported by middleware, which is compiled for the edge
    // runtime — a Node-only import reachable from there breaks EVERY route.
    const mode = readFileSync("src/lib/mode.ts", "utf8");
    expect(mode).not.toMatch(/^\s*import /m);
    expect(mode).toMatch(/process\.env\.OPNINFER_MODE === "console"/);
  });

  it("console API routes re-check the mode themselves", () => {
    // Defence in depth: the matcher is one edit away from not covering a path,
    // and this tree reads every client's data.
    const guard = readFileSync("src/lib/console/guard.ts", "utf8");
    expect(guard).toMatch(/if \(!IS_CONSOLE\) return new Response\(null, \{ status: 404 \}\)/);
    expect(guard).toMatch(/if \(!session\?\.user\)/);
  });

  it("the console layout re-checks too", () => {
    const layout = readFileSync("src/app/console/layout.tsx", "utf8");
    expect(layout).toMatch(/if \(!IS_CONSOLE\) notFound\(\)/);
    expect(layout).toMatch(/if \(!session\?\.user\) redirect\("\/login"\)/);
  });

  it("console sign-in never touches a users table", () => {
    const auth = readFileSync("src/auth.ts", "utf8");
    const branch = auth.slice(auth.indexOf("if (IS_CONSOLE) {"));
    const upToDb = branch.slice(0, branch.indexOf("const user = await db.user"));
    expect(upToDb).toMatch(/authorizeOperator\(email, parsed\.data\.password\)/);
    expect(upToDb).not.toMatch(/db\.user/);
    // And the 60-second session recheck is skipped — there is nothing to
    // re-read, and `db` is not reachable from that container.
    expect(auth).toMatch(/if \(IS_CONSOLE\) return token;/);
  });
});
