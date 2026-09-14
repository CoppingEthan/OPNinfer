import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Agent SDK in the app and the Claude Code CLI in the agent image ship in
 * lockstep, and drift between them is undefined behaviour — the SDK speaks a
 * control protocol the CLI of the same release understands. Nothing at
 * runtime checks this: a mismatched pair "works" until the day it doesn't,
 * with a symptom that looks like anything else.
 *
 * So it is pinned here, against the SOURCE of truth on each side: the CLI
 * version the installed SDK bundles (its manifest) and the version the image
 * installs (the Dockerfile's ARG). Bumping the SDK without the Dockerfile,
 * or vice versa, fails the suite. Same technique as changelog.test.ts.
 */
const ROOT = process.cwd();

function bundledCliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"), "utf8"),
  ) as { version?: string };
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  return manifest.version!;
}

function dockerfileCliVersion(): string {
  const dockerfile = readFileSync(path.join(ROOT, "docker/agent/Dockerfile"), "utf8");
  const m = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile);
  expect(m, "docker/agent/Dockerfile must declare ARG CLAUDE_CODE_VERSION").not.toBeNull();
  return m![1];
}

describe("agent image ↔ SDK version pin", () => {
  it("the Dockerfile installs exactly the CLI version the installed SDK bundles", () => {
    expect(dockerfileCliVersion()).toBe(bundledCliVersion());
  });

  it("the image disables the autoupdater, so a running container cannot drift", () => {
    const dockerfile = readFileSync(path.join(ROOT, "docker/agent/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/DISABLE_AUTOUPDATER=1/);
  });
});
