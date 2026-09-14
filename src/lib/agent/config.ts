import { z } from "zod";

/**
 * Sandbox agent tier — configuration core (pure; no server imports, so the
 * schema, bounds and defaults are unit-testable and shared with the admin
 * form the way `ask.ts` / `limits.ts` are).
 *
 * "Sandbox" is the user-facing name for the Claude Agent SDK tier that
 * replaces the old per-command sandbox: a full autonomous agent (the same
 * technology as Claude Code) working in an isolated per-chat container.
 * Registered as a CLIENT CAPABILITY (owner decision, 2026-08-24): off unless
 * an admin enables it, fully configurable on Admin → Tools.
 */

/** Reasoning effort levels the Agent SDK accepts (Options.effort). */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/**
 * Who pays for the agent's model calls — the architectural fork, not a
 * cosmetic one (see the design notes: the two modes want OPPOSITE credential
 * handling):
 *
 *  - `api` (default): the org's Anthropic key, which must NEVER enter the
 *    agent container — model traffic goes through OPNinfer's credential proxy
 *    (Stage 3). What client instances run.
 *  - `subscription`: the operator's own Claude plan. The credential lives in
 *    the agent container's config volume, written there by Anthropic's own
 *    /login flow — OPNinfer never touches, stores, or proxies it. Individual
 *    use of the operator's plan only; the admin card says so.
 */
export const AGENT_CREDENTIAL_MODES = ["api", "subscription"] as const;
export type AgentCredentialMode = (typeof AGENT_CREDENTIAL_MODES)[number];

/** Guard rails for the admin form. Step is 1 on every numeric field — a
 *  browser rejects any value that isn't min + k·step, which is how the Limits
 *  form once refused its own default (see CLAUDE.md). */
export const AGENT_BOUNDS = {
  maxTurns: { min: 1, max: 200 },
  /** Our own wall clock on a run. NB the chat turn hosting the run has its
   *  own 15-minute hard stop today — a longer agent budget needs the run
   *  detached from the turn (a Stage 5+ concern, bounded here anyway). */
  maxMinutes: { min: 1, max: 60 },
  /** Soft guard only — compared against the SDK's client-side estimate, and
   *  meaningless in subscription mode. The proxy is the hard ceiling. */
  maxBudgetUsd: { min: 0, max: 200 },
} as const;

export const AGENT_DEFAULT_MODEL = "claude-sonnet-5";

/**
 * A fixed, reserved conversation id used only by the admin "Check sign-in"
 * probe. Never a real chat, so its container and state directory are
 * disposable — and using the REAL attach path is the point: the credential
 * that matters is the one inside the agent container, not whatever the server
 * host happens to be signed in as.
 */
export const AGENT_PROBE_CONVERSATION_ID = "00000000-0000-4000-8000-00000000a9e7";

/**
 * A SECOND reserved id, for the plan-usage reading taken with the container
 * volume login (see limits-store.refreshPlanUsageViaVolume). Deliberately not
 * the one above: the sign-in check runs its probe on the TOKEN and this one
 * must run on the volume login, so they are two containers with two
 * credentials — sharing an id would have them tearing down each other's
 * container mid-check.
 */
export const AGENT_USAGE_PROBE_CONVERSATION_ID = "00000000-0000-4000-8000-00000000a9e8";

/**
 * Default steering text — how the run_agent_task tool sells itself to the
 * conversation model (owner ask, 2026-08-24: most substantive work should go
 * through the Sandbox, and the model should know it is Claude-Code-grade).
 * Admin-overridable so the strength can be tuned down if rate limits bite.
 */
export const AGENT_DEFAULT_STEERING =
  "The Sandbox is your primary way to get real work DONE — expect roughly " +
  "80% of substantive requests to go through it. It is a full autonomous " +
  "coding agent (the Claude Agent SDK — the same technology as Claude Code) " +
  "working in this chat's private workspace: it writes and edits files, runs " +
  "code and shell commands, sees the results, and iterates until the job " +
  "works. Delegate to it whenever a task involves creating or processing " +
  "files, writing or running code, data work, or anything multi-step that " +
  "benefits from iteration. Answer directly yourself only for conversation, " +
  "quick facts, or advice. Escalation is different: escalate for hard " +
  "REASONING that one excellent answer can settle; use the Sandbox for " +
  "long-running work that needs doing, checking, and redoing.";

/**
 * The capability's stored config. Everything has a default so a bare `{}`
 * (fresh enable, older stored shape) parses to a working setup, and numbers
 * are coerced because HTML forms submit strings.
 */
export const agentConfigSchema = z.object({
  credential: z.enum(AGENT_CREDENTIAL_MODES).default("api"),
  /** API mode: which stored org Anthropic credential the proxy will use.
   *  A provider_credentials row id; validated against the DB at run time,
   *  not here (the row can be deleted after this was saved). */
  credentialId: z.string().trim().max(64).optional(),
  model: z.string().trim().min(1).max(100).default(AGENT_DEFAULT_MODEL),
  effort: z.enum(AGENT_EFFORTS).default("high"),
  maxTurns: z.coerce
    .number()
    .int()
    .min(AGENT_BOUNDS.maxTurns.min)
    .max(AGENT_BOUNDS.maxTurns.max)
    .default(50),
  maxMinutes: z.coerce
    .number()
    .int()
    .min(AGENT_BOUNDS.maxMinutes.min)
    .max(AGENT_BOUNDS.maxMinutes.max)
    .default(10),
  maxBudgetUsd: z.coerce
    .number()
    .min(AGENT_BOUNDS.maxBudgetUsd.min)
    .max(AGENT_BOUNDS.maxBudgetUsd.max)
    .default(10),
  /** Overrides AGENT_DEFAULT_STEERING when non-empty. */
  steering: z.string().max(2_000).default(""),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Parse stored config defensively: bad/missing fields fall back to defaults
 *  rather than disabling the capability (fail-open on SHAPE, because every
 *  field has a safe default — unlike secrets-bearing capabilities, which
 *  fail closed in the registry). */
export function parseAgentConfig(raw: unknown): AgentConfig {
  const r = agentConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : agentConfigSchema.parse({});
}

/** The steering text in force — admin override when set, else the default. */
export function agentSteering(cfg: AgentConfig): string {
  return cfg.steering.trim() || AGENT_DEFAULT_STEERING;
}
