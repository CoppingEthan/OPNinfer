import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyMcpStatuses,
  describeMcpServers,
  mcpAuthState,
  mcpHealthMessage,
  mcpServerOf,
  mcpToolLabel,
  parseAgentMcp,
  readyMcpServers,
  sdkMcpServers,
  type AgentMcpState,
} from "./mcp";

const FIGMA_URL = "https://mcp.figma.com/mcp";

/**
 * Claude Code's key for a stored MCP OAuth token, reproduced. Observed live
 * (2026-09-03, CLI 2.1.241): after `claude mcp add --transport http figma
 * https://mcp.figma.com/mcp` the credentials file held
 * `mcpOAuth["figma|d39d3b6252bc1ac5"]`, and the CLI's own function is
 * `${name}|sha256(JSON.stringify({type, url, headers: headers || {}})).slice(0, 16)`.
 * If this ever stops matching, a signed-in server would silently read as
 * signed out at run time — so the exact observed value is pinned here.
 */
function claudeCodeKey(name: string, s: { type: string; url: string; headers?: Record<string, string> }): string {
  const h = createHash("sha256")
    .update(JSON.stringify({ type: s.type, url: s.url, headers: s.headers ?? {} }))
    .digest("hex")
    .slice(0, 16);
  return `${name}|${h}`;
}

describe("parseAgentMcp — what sandboxd reads out of the instance's volume", () => {
  it("keeps valid remote and local servers, drops junk, never fails as a whole", () => {
    const s = parseAgentMcp({
      servers: {
        figma: { type: "http", url: FIGMA_URL },
        notes: { type: "sse", url: "https://notes.example/sse", headers: { "X-Key": "abc" } },
        local: { command: "npx", args: ["-y", "some-mcp"], env: { A: "1" } },
        bad1: { type: "http" }, // no url
        bad2: { type: "http", url: "ftp://nope" },
        "bad name!": { type: "http", url: FIGMA_URL },
        opninfer: { type: "http", url: FIGMA_URL }, // reserved for our own server
      },
      oauth: { figma: true, ghost: true, notes: "yes" },
    });
    expect(Object.keys(s.servers).sort()).toEqual(["figma", "local", "notes"]);
    expect(s.oauth).toEqual({ figma: true }); // only true, only for known servers
  });

  it("copes with garbage input", () => {
    expect(parseAgentMcp(null)).toEqual({ servers: {}, oauth: {} });
    expect(parseAgentMcp("x")).toEqual({ servers: {}, oauth: {} });
    expect(parseAgentMcp({ servers: 3, oauth: [] })).toEqual({ servers: {}, oauth: {} });
  });
});

describe("auth state and what the agent gets", () => {
  const state: AgentMcpState = parseAgentMcp({
    servers: {
      figma: { type: "http", url: FIGMA_URL },
      jira: { type: "http", url: "https://mcp.example/jira" },
      keyed: { type: "http", url: "https://mcp.example/keyed", headers: { Authorization: "Bearer t" } },
      local: { command: "some-mcp" },
    },
    oauth: { figma: true },
  });

  it("a stored token, a fixed auth header, or a local command = ready; else needs a sign-in", () => {
    expect(mcpAuthState("figma", state.servers.figma, state)).toBe("ready");
    expect(mcpAuthState("jira", state.servers.jira, state)).toBe("needs-sign-in");
    expect(mcpAuthState("keyed", state.servers.keyed, state)).toBe("ready");
    expect(mcpAuthState("local", state.servers.local, state)).toBe("ready");
    expect(readyMcpServers(state)).toEqual(["figma", "keyed", "local"]);
  });

  it("runs get only the ready servers; the admin check gets them all", () => {
    expect(Object.keys(sdkMcpServers(state)).sort()).toEqual(["figma", "keyed", "local"]);
    expect(Object.keys(sdkMcpServers(state, { all: true })).sort()).toEqual(["figma", "jira", "keyed", "local"]);
  });

  it("passes exactly the fields Claude Code hashes, so the stored token is found", () => {
    const sdk = sdkMcpServers(state);
    expect(sdk.figma).toEqual({ type: "http", url: FIGMA_URL });
    expect(sdk.keyed).toEqual({ type: "http", url: "https://mcp.example/keyed", headers: { Authorization: "Bearer t" } });
    expect(sdk.local).toEqual({ type: "stdio", command: "some-mcp" });
    // The observed key for the real Figma server, byte for byte.
    expect(claudeCodeKey("figma", sdk.figma as { type: string; url: string })).toBe("figma|d39d3b6252bc1ac5");
    // …and a header changes the key, which is why headers must pass through untouched.
    expect(claudeCodeKey("figma", { type: "http", url: FIGMA_URL, headers: { "X-A": "1" } })).not.toBe("figma|d39d3b6252bc1ac5");
  });

  it("describes ready servers for the prompts, and nothing when there are none", () => {
    expect(describeMcpServers(state)).toBe(`figma (${FIGMA_URL}), keyed (https://mcp.example/keyed), local (local command)`);
    expect(describeMcpServers({ servers: {}, oauth: {} })).toBe("");
    expect(describeMcpServers(parseAgentMcp({ servers: { jira: { type: "http", url: "https://x.example/m" } } }))).toBe("");
  });
});

describe("mcpToolLabel — the status line for a connected service's tool", () => {
  it("names the service and the action in words", () => {
    expect(mcpToolLabel("mcp__figma__get_design_context")).toBe("Using Figma: get design context");
    expect(mcpToolLabel("mcp__my_server__do-thing")).toBe("Using My_server: do thing");
  });
  it("hides OPNinfer's own server and ignores non-MCP names", () => {
    expect(mcpToolLabel("mcp__opninfer__present_files")).toBeNull();
    expect(mcpToolLabel("Bash")).toBeNull();
  });
});

describe("classifyMcpStatuses — what the CLI reported vs what was set up", () => {
  it("a ready server that is not connected is broken; one awaiting its first sign-in is neither", () => {
    const h = classifyMcpStatuses(
      [
        { name: "figma", status: "needs-auth" },
        { name: "jira", status: "needs-auth" },
        { name: "opninfer", status: "connected" },
      ],
      { ready: ["figma"], known: ["figma", "jira"] },
    );
    expect(h.broken).toEqual([{ name: "figma", status: "needs-auth" }]);
    expect(h.unexpected).toEqual([]);
  });

  it("a server the CLI reports that was never set up here is UNEXPECTED (the connector tripwire)", () => {
    const h = classifyMcpStatuses(
      [
        { name: "figma", status: "connected" },
        { name: "claude.ai Gmail", status: "connected" },
      ],
      { ready: ["figma"], known: ["figma"] },
    );
    expect(h.broken).toEqual([]);
    expect(h.unexpected).toEqual(["claude.ai Gmail"]);
  });

  it("a ready server the CLI never mentioned counts as broken (missing), and errors ride along", () => {
    const h = classifyMcpStatuses([{ name: "figma", status: "failed", error: "ECONNRESET" }], { ready: ["figma", "ghost"], known: ["figma", "ghost"] });
    expect(h.broken).toEqual([
      { name: "figma", status: "failed", error: "ECONNRESET" },
      { name: "ghost", status: "missing" },
    ]);
  });

  it("the log wording is stable per state (it is the alert's subject and throttle key)", () => {
    expect(mcpHealthMessage("figma", "needs-auth")).toBe(
      'Sandbox connected service "figma" is signed out — runs can\'t use it until it is signed in again',
    );
    expect(mcpHealthMessage("figma", "failed")).toBe('Sandbox connected service "figma" is not connecting (failed)');
    expect(mcpServerOf("mcp__figma__get_design_context")).toBe("figma");
    expect(mcpServerOf("Bash")).toBeNull();
  });
});

