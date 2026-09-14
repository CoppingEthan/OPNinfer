import "server-only";
import { getSetting } from "@/lib/settings";
import type { Capability, CapabilityStored } from "./types";
import { agentConfigSchema, parseAgentConfig, type AgentConfig } from "@/lib/agent/config";
import { AGENT_TOOL_NAME } from "@/lib/agent/policy";
import { executeSandboxTask, sandboxTaskDef } from "@/lib/tools/sandbox-task";
import { fetchAgentMcp } from "@/lib/agent/mcp-store";
import { readyMcpServers } from "@/lib/agent/mcp";

/**
 * Sandbox — the Claude Agent SDK tier (v0.4). A full autonomous coding agent
 * per chat, replacing the old one-command-at-a-time sandbox (retired in the
 * final stage of this build). Registered as a client capability (owner
 * decision, 2026-08-24): ships OFF, enabled + configured per instance on
 * Admin → Tools like any other capability — but with its own card, because
 * the credential-mode choice (org API key vs the operator's own Claude
 * subscription) needs more than a generic form.
 *
 * The tool it offers is `sandbox_task` (src/lib/tools/sandbox-task.ts), built
 * per turn so its description carries the admin's current steering text. The
 * pure config core lives in `src/lib/agent/config.ts`; the env constructor
 * (the credential-safety guard) in `src/lib/agent/env.ts`; the permission
 * policy in `src/lib/agent/policy.ts`.
 */
export const SANDBOX_AGENT_ID = "sandbox_agent";

export const sandboxAgent: Capability = {
  id: SANDBOX_AGENT_ID,
  label: "Sandbox",
  description:
    "An autonomous agent workspace for each chat: writes and edits files, runs " +
    "real code and shell commands, and iterates until the job is done. " +
    "Powered by the Claude Agent SDK.",
  tools: [], // built per turn by toolsFor — the description carries live steering
  // Async (2026-09-03): the description also names the instance's connected
  // services (MCP) — cached, stale-while-revalidate, never a wait on a turn.
  toolsFor: async (config) => [sandboxTaskDef(parseAgentConfig(config), readyMcpServers(await fetchAgentMcp()))],
  configSchema: agentConfigSchema,
  // No secret fields BY DESIGN: API mode references a provider_credentials
  // row by id (the key stays in that table's encrypted store, behind the
  // proxy), and the subscription credential lives in the agent container's
  // own volume, written by Anthropic's /login flow — never in settings.
  secretFields: [],
  async execute(tool, args, config, ctx) {
    if (tool === AGENT_TOOL_NAME) return executeSandboxTask(args, parseAgentConfig(config), ctx);
    return `Error: unknown tool "${tool}".`;
  },
};

/** The Sandbox tier's effective state: enabled flag + parsed, defaulted
 *  config. What every later stage (spawn, proxy, tool registration) reads.
 *
 *  Reads the `capability_<id>` setting directly rather than through
 *  registry.getCapabilityState: the registry imports this module to build
 *  CAPABILITIES at module-init time, so importing it back would be a cycle
 *  that TDZ-crashes when this file happens to load first (NOT the benign
 *  call-time cycle pipeline.ts documents). No secrets are lost by skipping
 *  the registry's decryption — this capability stores none by design. */
export async function getSandboxAgentState(): Promise<{
  enabled: boolean;
  config: AgentConfig;
}> {
  const stored = await getSetting<CapabilityStored>(`capability_${SANDBOX_AGENT_ID}`);
  return {
    enabled: stored?.enabled === true,
    config: parseAgentConfig(stored?.config),
  };
}
