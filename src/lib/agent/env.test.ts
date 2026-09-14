import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { agentOauthToken, agentTokenSource, buildAgentEnv } from "./env";

/**
 * The whole correctness guard of the credential design, as promised in the
 * design notes: "Assert in a unit test that no ANTHROPIC_API_KEY ever appears
 * in this object. That's the whole correctness guard, and it's one test."
 * (Plus its friends: the traps the spike found live.)
 */

/** A hostile base env: everything that must NOT survive, plus what must. */
const HOSTILE_BASE = {
  // The org's decrypted key sitting in the server process — the big one.
  ANTHROPIC_API_KEY: "sk-ant-REAL-ORG-KEY",
  ANTHROPIC_BASE_URL: "https://evil.example.com",
  ANTHROPIC_AUTH_TOKEN: "stale-token",
  // Nested-session plumbing (the server itself may run under Claude Code).
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "abc",
  CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  CLAUDE_CONFIG_DIR: "/somebody/elses/.claude",
  CLAUDE_CODE_OAUTH_TOKEN: "oat-123",
  AI_AGENT: "1",
  // Host path context — leaked PWD sent the spike's first run to the repo root.
  PWD: "/c/Users/owner/repo",
  OLDPWD: "/c/Users/owner",
  INIT_CWD: "/c/Users/owner/repo",
  // Safe vars that MUST pass through.
  PATH: "/usr/bin:/bin",
  HOME: "/home/agent",
  TMP: "/tmp",
  LANG: "en_GB.UTF-8",
};

describe("buildAgentEnv", () => {
  it("never lets ANTHROPIC_API_KEY reach the agent, in either mode", () => {
    const sub = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    const api = buildAgentEnv({
      credential: "api",
      base: HOSTILE_BASE,
      proxy: { baseUrl: "http://proxy:8787/anthropic", token: "per-chat" },
    });
    for (const env of [sub, api]) {
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
    }
  });

  it("no CLAUDE/ANTHROPIC var from the BASE survives — only the builder's own may exist", () => {
    const env = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    // Every hostile inherited var is gone…
    for (const k of Object.keys(HOSTILE_BASE)) {
      if (/^(ANTHROPIC|CLAUDE|AI_AGENT)/i.test(k)) expect(env[k]).toBeUndefined();
    }
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // …and any CLAUDE-prefixed key present is one the builder itself set,
    // never something smuggled through from the base.
    const OWN = new Set([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    for (const k of Object.keys(env)) {
      if (/^(ANTHROPIC|CLAUDE|AI_AGENT)/i.test(k)) expect(OWN.has(k)).toBe(true);
    }
  });

  it("strips host path context (PWD/OLDPWD/INIT_CWD) — the repo-root write trap", () => {
    const env = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    expect(env.PWD).toBeUndefined();
    expect(env.OLDPWD).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
  });

  it("passes safe vars through", () => {
    const env = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.LANG).toBe("en_GB.UTF-8");
  });

  it("a long-lived token is the ONLY auth subscription mode may set", () => {
    const env = buildAgentEnv({
      credential: "subscription",
      base: HOSTILE_BASE,
      oauthToken: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz",
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
    // Still nothing pointing at Anthropic directly, and still no org key.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("API mode ignores a token — the proxy is its only auth", () => {
    // Both set would be two credentials in one container, and the CLI's
    // precedence would decide which one paid. It must be the proxy.
    const env = buildAgentEnv({
      credential: "api",
      base: HOSTILE_BASE,
      oauthToken: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz",
      proxy: { baseUrl: "http://proxy:8787/anthropic", token: "per-chat" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("per-chat");
  });

  it("subscription mode sets NOTHING auth-shaped", () => {
    const env = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // The container volume's /login credential is the only auth in play, so
    // an inherited CLAUDE_CONFIG_DIR pointing elsewhere must be gone too.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("api mode points the CLI at the proxy, never at Anthropic directly", () => {
    const env = buildAgentEnv({
      credential: "api",
      base: HOSTILE_BASE,
      proxy: { baseUrl: "http://proxy:8787/anthropic", token: "per-chat-bearer" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy:8787/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("per-chat-bearer");
  });

  it("api mode WITHOUT a proxy throws — the raw-key fallback must be impossible", () => {
    expect(() => buildAgentEnv({ credential: "api", base: HOSTILE_BASE })).toThrow(
      /proxy/,
    );
  });

  it("always sets the hygiene vars", () => {
    const env = buildAgentEnv({ credential: "subscription", base: {} });
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    // Live code previews depend on this (the CLI buffers tool input otherwise).
    expect(env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING).toBe("1");
  });

  it("sets CLAUDE_CONFIG_DIR only when the caller provides one (containers)", () => {
    const bare = buildAgentEnv({ credential: "subscription", base: HOSTILE_BASE });
    expect(bare.CLAUDE_CONFIG_DIR).toBeUndefined();
    const dir = buildAgentEnv({
      credential: "subscription",
      base: HOSTILE_BASE,
      configDir: "/config/chat-123",
    });
    expect(dir.CLAUDE_CONFIG_DIR).toBe("/config/chat-123");
  });

  it("tolerates an empty/missing base", () => {
    const env = buildAgentEnv({ credential: "subscription" });
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    // Live code previews depend on this (the CLI buffers tool input otherwise).
    expect(env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING).toBe("1");
  });

  /**
   * The instance's long-lived token (2026-09-07). Stored base64 because
   * docker compose interpolates `$` inside an env_file — the bug that made
   * the operator console read "no accounts are configured" — and checked
   * for shape, because a value that arrived mangled must read as
   * "misconfigured", not be handed to the CLI to reject at run time.
   */
  describe("reading the configured token", () => {
    const TOKEN = "sk-ant-oat01-AbCd_1234-EfGh5678ijklMNOP";
    afterEach(() => {
      delete process.env.AGENT_OAUTH_TOKEN_B64;
      delete process.env.AGENT_OAUTH_TOKEN;
    });

    it("reads the base64 form", () => {
      process.env.AGENT_OAUTH_TOKEN_B64 = Buffer.from(TOKEN).toString("base64");
      expect(agentOauthToken()).toBe(TOKEN);
      expect(agentTokenSource()).toBe("token");
    });

    it("reads a plain one set by hand", () => {
      process.env.AGENT_OAUTH_TOKEN = `  ${TOKEN}  `;
      expect(agentOauthToken()).toBe(TOKEN);
    });

    it("no token configured means the container volume login", () => {
      expect(agentOauthToken()).toBeUndefined();
      expect(agentTokenSource()).toBe("none");
      expect(buildAgentEnv({ credential: "subscription", oauthToken: agentOauthToken() })
        .CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("a mangled value is reported, never used", () => {
      // Buffer.from skips what it cannot decode rather than throwing, so
      // decoding rubbish yields rubbish that must not pass for a token.
      process.env.AGENT_OAUTH_TOKEN_B64 = "not really base64 !!!";
      expect(agentOauthToken()).toBeUndefined();
      expect(agentTokenSource()).toBe("malformed");
    });

    it("refuses a value compose could have chewed", () => {
      // What an env_file `$` substitution leaves behind: a truncated string.
      process.env.AGENT_OAUTH_TOKEN = "sk-ant-";
      expect(agentTokenSource()).toBe("malformed");
      expect(agentOauthToken()).toBeUndefined();
    });

    it("refuses an organisation API key pasted in by mistake", () => {
      // It is sk-ant-shaped, so only an explicit check stops it: a raw org
      // key in an agent's environment is the one thing buildAgentEnv exists
      // to prevent, and it would bill the API while the admin believed they
      // were on the plan.
      process.env.AGENT_OAUTH_TOKEN = "sk-ant-api03-realkey-not-an-oauth-token";
      expect(agentTokenSource()).toBe("malformed");
      expect(agentOauthToken()).toBeUndefined();
    });
  });
});
