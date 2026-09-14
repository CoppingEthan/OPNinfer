import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin "Check sign-in" probe must ask the CLI **inside the agent
 * container**, never the one on the server host.
 *
 * This is asserted against the SOURCE, because no assertion about the OUTPUT
 * could catch it: a host-side check returns a perfectly well-formed, entirely
 * confident answer — it just answers about the wrong machine. It shipped that
 * way and reported the developer's own account (Claude Max) while the
 * container was signed in as someone else (Claude Pro). On a deployed
 * instance the same bug reports "signed in" for a container that is not, and
 * the first symptom is every agent run failing with "Not logged in".
 *
 * Same technique as changelog.test.ts asserting the Dockerfile COPY: the
 * failure has no symptom you would go looking for, so pin the rule where it
 * can't quietly rot.
 */
const SOURCE = readFileSync(
  path.join(process.cwd(), "src/app/actions/tools.ts"),
  "utf8",
);

/** The body of checkAgentAccount, up to the next exported function. */
function accountCheckBody(): string {
  const start = SOURCE.indexOf("export async function checkAgentAccount");
  expect(start).toBeGreaterThan(-1);
  const after = SOURCE.indexOf("export async function", start + 10);
  return SOURCE.slice(start, after === -1 ? undefined : after);
}

describe("checkAgentAccount routes through the agent container", () => {
  it("passes spawnClaudeCodeProcess, so the CLI runs in the container", () => {
    expect(accountCheckBody()).toContain("spawnClaudeCodeProcess");
  });

  it("builds that spawner from the agent spawn module", () => {
    expect(accountCheckBody()).toContain("makeAgentSpawner");
  });

  it("never hands the server's own environment to the probe", () => {
    // `base: process.env` would drag the host's CLAUDE_CONFIG_DIR (and, on a
    // deployed instance, the org's ANTHROPIC_API_KEY) toward the CLI. The env
    // is constructed from explicit container paths instead.
    const body = accountCheckBody();
    expect(body).not.toContain("base: process.env");
    expect(body).toContain("configDir");
  });

  it("tears the disposable probe container down again", () => {
    expect(accountCheckBody()).toContain("destroyAgentContainer");
  });

  it("refuses honestly when the broker isn't configured", () => {
    expect(accountCheckBody()).toContain("SANDBOX_BROKER_URL");
  });

  // 2026-09-04, found in production: accountInfo() reports what the CLI has
  // STORED, so a sign-in whose refresh token had been rotated (a cloned
  // host) read "Signed in" all day while every run failed over to the org
  // key. The check must make the plan ANSWER and judge the outcome with the
  // classifier the runs use — never trust the stored account alone.
  it("sends a real request and judges it with the runs' classifier", () => {
    const body = accountCheckBody();
    expect(body).toContain('content: "Reply with exactly: OK"');
    expect(body).toContain("classifySubscriptionFailure");
    expect(body).not.toMatch(/async function\* idle\(\)/);
  });

  it("logs the SAME error row a failing run does, so the alert email fires from the check too", () => {
    expect(accountCheckBody()).toContain('"Sandbox subscription: signed out — runs need /login"');
  });
});
