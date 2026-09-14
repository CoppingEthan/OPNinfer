import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The production app image is a Next.js STANDALONE build: it ships only the
 * files the tracer can follow from imports. The Agent SDK's Claude Code CLI
 * is a native binary in a platform package (`@anthropic-ai/claude-agent-sdk-
 * linux-x64` on the servers) that the SDK resolves by name at runtime, so the
 * tracer never sees it and the SDK then refuses to start: "Claude Code
 * executable not found". Found on the first production deploy of the agent
 * tier (2026-09-02) — the Sandbox worked in every dev harness and failed on
 * its first real chat with "missing CLI binary". Same class as the
 * CHANGELOG.md COPY gotcha: the failure has no symptom outside a standalone
 * build, so this test reads the config rather than trusting memory.
 */
describe("standalone build traces the Agent SDK's platform binary", () => {
  const cfg = readFileSync("next.config.ts", "utf8");

  it("next.config.ts includes the SDK's store directory in the trace", () => {
    expect(cfg).toMatch(/outputFileTracingIncludes/);
    // The SDK's own pnpm store directory. Node resolves the platform package
    // from inside it (the sibling `node_modules/@anthropic-ai/` scope), so
    // this one glob is what puts the CLI binary in the image.
    expect(cfg).toMatch(/\.pnpm\/@anthropic-ai\+claude-agent-sdk@\*\/\*\*/);
  });

  it("does NOT also match the platform package's own store directory", () => {
    // `sdk*` matched `@anthropic-ai+claude-agent-sdk-linux-x64@<version>` too,
    // and because the tracer dereferences pnpm's symlinks the 327 MB binary
    // was copied TWICE — ~0.7 GB of app image for nothing (2026-09-05). The
    // `@` before the `*` is the whole fix, so pin it: a glob that would match
    // a `-linux-x64` directory is the bug coming back.
    const globs = cfg.match(/outputFileTracingIncludes:\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(globs).not.toMatch(/claude-agent-sdk\*/);
    expect(globs).toMatch(/claude-agent-sdk@\*/);
  });

  it("the SDK is left as a runtime require (its own requires must resolve on disk)", () => {
    const m = cfg.match(/serverExternalPackages:\s*\[([^\]]*)\]/);
    expect(m, "serverExternalPackages present").toBeTruthy();
    expect(m![1]).toMatch(/@anthropic-ai\/claude-agent-sdk/);
  });
});
