import "server-only";
import { brokerGet } from "./broker";
import { EMPTY_MCP, parseAgentMcp, type AgentMcpState } from "./mcp";

/**
 * The instance's connected services, as sandboxd reads them out of the agent
 * credential volume (see mcp.ts for where they come from).
 *
 * Read on every turn (the sandbox_task description names them), so it is
 * cached and STALE-WHILE-REVALIDATE: an expired cache answers immediately
 * with what it has and refreshes in the background — the read is a
 * throwaway container on the broker's side, ~1 s, and a turn must never
 * wait for it. The admin page passes `fresh` so it always shows the truth,
 * and that same load is what pushes a just-run `agent-mcp add` into the
 * cache. globalThis-anchored like every other per-process cache here (Next
 * instantiates modules per route bundle).
 */

const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 15_000;

interface Cache {
  at: number;
  ttl: number;
  state: AgentMcpState;
  inflight: Promise<AgentMcpState> | null;
}
const g = globalThis as unknown as { __oiAgentMcp?: Cache };

async function load(fresh: boolean): Promise<AgentMcpState> {
  const raw = await brokerGet<unknown>(`/agent-mcp${fresh ? "?fresh=1" : ""}`, { timeoutMs: 30_000 });
  const state = raw ? parseAgentMcp(raw) : EMPTY_MCP;
  g.__oiAgentMcp = { at: Date.now(), ttl: raw ? TTL_MS : FAIL_TTL_MS, state, inflight: null };
  return state;
}

export async function fetchAgentMcp(opts: { fresh?: boolean } = {}): Promise<AgentMcpState> {
  if (!process.env.SANDBOX_BROKER_TOKEN) return EMPTY_MCP;
  const c = g.__oiAgentMcp;
  if (opts.fresh || !c) {
    if (c?.inflight && !opts.fresh) return c.inflight;
    const p = load(!!opts.fresh);
    if (c) c.inflight = p;
    else g.__oiAgentMcp = { at: 0, ttl: 0, state: EMPTY_MCP, inflight: p };
    return p;
  }
  if (Date.now() - c.at >= c.ttl && !c.inflight) {
    // Stale: answer now, refresh behind the scenes.
    c.inflight = load(false).catch(() => c.state);
  }
  return c.state;
}
