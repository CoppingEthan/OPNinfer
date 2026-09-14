import { z } from "zod";

/**
 * Connected services (MCP servers) for the Sandbox agent — the pure core
 * (no server imports; unit-tested; client-safe for the admin panel).
 *
 * THE SOURCE OF TRUTH IS CLAUDE CODE'S OWN CONFIG, per instance (owner ask,
 * 2026-09-03: "auth'd inside Claude Code directly, not jerry-rigged"). The
 * operator runs `./deploy.sh agent-mcp <instance> add <name> <url>` — which
 * is `claude mcp add -s user` inside that instance's agent credential
 * volume — and `… login <name>`, which is Anthropic's own `claude mcp login
 * --no-browser` flow (open the URL, approve, paste the redirect URL back).
 * So the server list lives in the volume's `.claude.json`, and its sign-in
 * in `.credentials.json` — the very file that already carries the Claude
 * sign-in and is symlinked into every chat's config dir and synced back
 * after each run. Nothing is stored in OPNinfer's database; no token ever
 * passes through the app. One instance has Figma, the others don't, simply
 * because only that instance's volume was set up.
 *
 * sandboxd reads the two files out of a throwaway container from the agent
 * image (`GET /agent-mcp`) and returns the server list plus a per-server
 * "has a stored token" flag — never the token. This module validates that
 * and decides what the agent, the conversation model and the admin page see.
 *
 * WHY THE SHAPE MATTERS: Claude Code keys a stored OAuth token by
 * `<name>|sha256(JSON.stringify({type, url, headers: headers ?? {}}))[:16]`
 * (`mcp.test.ts` pins this against a key observed live). The server we hand
 * the SDK must therefore carry exactly the stored name, type, url and
 * headers — add a header, change a slash, and the sign-in silently "goes
 * missing". `sdkMcpServers` passes those fields and nothing else.
 */

/** Reserved for OPNinfer's own in-process MCP server (present_files). */
export const MCP_RESERVED_NAMES: ReadonlySet<string> = new Set(["opninfer"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const stringMap = z.record(z.string(), z.string());
const remoteSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "http(s) only"),
  headers: stringMap.optional(),
});
const stdioSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
});
export const agentMcpServerSchema = z.union([remoteSchema, stdioSchema]);
export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>;

export interface AgentMcpState {
  /** Validated servers, by name, as stored in the volume's `.claude.json`. */
  servers: Record<string, AgentMcpServer>;
  /** Names that have a stored OAuth token (never the token itself). */
  oauth: Record<string, boolean>;
}

export const EMPTY_MCP: AgentMcpState = { servers: {}, oauth: {} };

/** Validate what sandboxd returned. Bad entries are dropped, not fatal — one
 *  malformed server must not take the others (or the run) down. */
export function parseAgentMcp(raw: unknown): AgentMcpState {
  const out: AgentMcpState = { servers: {}, oauth: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { servers?: unknown; oauth?: unknown };
  if (r.servers && typeof r.servers === "object") {
    for (const [name, cfg] of Object.entries(r.servers as Record<string, unknown>)) {
      if (!NAME_RE.test(name) || MCP_RESERVED_NAMES.has(name)) continue;
      const p = agentMcpServerSchema.safeParse(cfg);
      if (p.success) out.servers[name] = p.data;
    }
  }
  if (r.oauth && typeof r.oauth === "object") {
    for (const [name, v] of Object.entries(r.oauth as Record<string, unknown>)) {
      if (v === true && name in out.servers) out.oauth[name] = true;
    }
  }
  return out;
}

export type McpAuthState = "ready" | "needs-sign-in";

/** Can the agent use this server as things stand? A local command needs no
 *  sign-in; a remote server is ready with a stored OAuth token or a fixed
 *  Authorization header (`claude mcp add … --header`). */
export function mcpAuthState(name: string, server: AgentMcpServer, state: AgentMcpState): McpAuthState {
  if (!("url" in server)) return "ready";
  const hasAuthHeader = Object.keys(server.headers ?? {}).some((h) => h.toLowerCase() === "authorization");
  if (hasAuthHeader) return "ready";
  return state.oauth[name] ? "ready" : "needs-sign-in";
}

/** Names the agent can actually use right now, sorted. */
export function readyMcpServers(state: AgentMcpState): string[] {
  return Object.keys(state.servers)
    .filter((n) => mcpAuthState(n, state.servers[n], state) === "ready")
    .sort();
}

/**
 * The `mcpServers` option for the SDK. Runs get the READY servers only (a
 * server that needs a sign-in would just fail to connect and clutter the
 * run); the admin check passes `all` so it can report the truth per server.
 * Field set is deliberately minimal — see the key-hash note at the top.
 */
export function sdkMcpServers(state: AgentMcpState, opts: { all?: boolean } = {}): Record<string, AgentMcpServer> {
  const out: Record<string, AgentMcpServer> = {};
  for (const [name, s] of Object.entries(state.servers)) {
    if (!opts.all && mcpAuthState(name, s, state) !== "ready") continue;
    out[name] =
      "url" in s
        ? { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
        : { type: "stdio", command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
  }
  return out;
}

/** One line for prompts: "figma (https://mcp.figma.com/mcp), jira (…)". Ready
 *  servers only — telling a model it has a service it can't reach produces
 *  failed runs, not honesty. */
export function describeMcpServers(state: AgentMcpState): string {
  return readyMcpServers(state)
    .map((n) => {
      const s = state.servers[n];
      return "url" in s ? `${n} (${s.url})` : `${n} (local command)`;
    })
    .join(", ");
}

/** Status line for a call to a connected service's tool:
 *  `mcp__figma__get_design_context` → "Using Figma: get design context".
 *  Null for OPNinfer's own server (its tools produce their own UI). */
export function mcpToolLabel(toolName: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return null;
  const [, server, tool] = m;
  if (MCP_RESERVED_NAMES.has(server)) return null;
  const pretty = server.charAt(0).toUpperCase() + server.slice(1);
  const words = tool.replace(/[_-]+/g, " ").trim();
  const label = `Using ${pretty}: ${words}`;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

/** Server name from an MCP tool name (`mcp__figma__get_x` → "figma"), else null. */
export function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? m[1] : null;
}

export interface McpStatusLike {
  name: string;
  status: string;
  error?: string;
}

export interface McpHealth {
  /** Ready (signed-in) servers the CLI could NOT use this time. */
  broken: { name: string; status: string; error?: string }[];
  /** Servers the CLI reported that were never set up here — must be none.
   *  (A subscription login carries the account's claude.ai connectors;
   *  strict mode keeps them out, and the permission layer refuses their
   *  tools regardless — this is the tripwire that says if either slipped.) */
  unexpected: string[];
}

/**
 * Judge what the CLI reported against what we asked for. `ready` = the
 * servers passed to a run (signed in); `known` = every server set up for
 * the instance, signed in or not — a server awaiting its first sign-in is
 * neither broken nor unexpected.
 */
export function classifyMcpStatuses(
  statuses: McpStatusLike[],
  opts: { ready: string[]; known: string[] },
): McpHealth {
  const seen = new Set<string>();
  const broken: McpHealth["broken"] = [];
  const unexpected: string[] = [];
  for (const s of statuses) {
    seen.add(s.name);
    if (MCP_RESERVED_NAMES.has(s.name)) continue;
    if (!opts.known.includes(s.name)) {
      unexpected.push(s.name);
      continue;
    }
    if (opts.ready.includes(s.name) && s.status !== "connected") {
      broken.push({ name: s.name, status: s.status, ...(s.error ? { error: s.error } : {}) });
    }
  }
  for (const name of opts.ready) {
    if (!seen.has(name)) broken.push({ name, status: "missing" });
  }
  return { broken, unexpected };
}

/** Stable wording for the error log — it is also the alert email's subject
 *  and the throttle key, so it must not carry anything that varies. */
export function mcpHealthMessage(name: string, status: string): string {
  return status === "needs-auth"
    ? `Sandbox connected service "${name}" is signed out — runs can't use it until it is signed in again`
    : `Sandbox connected service "${name}" is not connecting (${status})`;
}

