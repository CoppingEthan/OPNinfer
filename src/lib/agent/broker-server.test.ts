import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-pinned: the broker's HTTP server must never carry Node's default
 * five-minute `requestTimeout`. A Sandbox run is ONE request held open for
 * its whole life (the CLI's stdin is the request body), so with the default
 * every run longer than five minutes was cut off at 5:00–5:30 mid-command,
 * the container torn down, and nothing logged (found live 2026-09-10). No
 * output assertion can catch a default being restored — only the source can.
 */
describe("sandboxd http server", () => {
  const src = readFileSync(new URL("../../../sandboxd/index.mjs", import.meta.url), "utf8");

  it("turns off requestTimeout on the server that holds the attach stream", () => {
    expect(src).toMatch(/\bserver\.requestTimeout\s*=\s*0\b/);
  });

  it("keeps a headers guard, which Node only allows when requestTimeout is 0 or larger", () => {
    expect(src).toMatch(/\bserver\.headersTimeout\s*=\s*\d[\d_]*\b/);
  });

  it("sets both before listen()", () => {
    const at = (re: RegExp) => src.search(re);
    expect(at(/\bserver\.requestTimeout\s*=/)).toBeGreaterThan(-1);
    expect(at(/\bserver\.requestTimeout\s*=/)).toBeLessThan(at(/\bserver\.listen\(/));
  });
});
