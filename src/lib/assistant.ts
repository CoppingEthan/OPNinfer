import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import type { ProviderId } from "@/lib/providers/types";

/**
 * The branded assistant (v0.2). Instead of users picking a model, an admin
 * configures one assistant — a name + logo and four model roles, each bound to
 * a stored provider credential. Persisted as a single `settings` row.
 */
export type AssistantRole =
  | "frontend"
  | "conversation"
  | "escalation"
  | "failover";

/** Roles that appear in usage_records: the four configured model roles plus
 *  the v0.3 support calls (tool-router classifier, context-curation
 *  summarizer, image generation). */
/** `agent` (v0.4): a Sandbox agent run — the Agent SDK's own model calls,
 *  recorded from its per-model usage report. */
export type UsageRole =
  | AssistantRole
  | "router"
  | "curator"
  | "image"
  | "agent"
  | "memory"
  // Conversation compaction (2026-09-10): the front-end model summarising
  // the older part of a long chat.
  | "compaction";

export const ASSISTANT_ROLES: AssistantRole[] = [
  "frontend",
  "conversation",
  "escalation",
  "failover",
];

export const ROLE_LABELS: Record<
  AssistantRole,
  { title: string; blurb: string }
> = {
  frontend: {
    title: "Front-end",
    blurb: "Cheap model — conversation titles, follow-up suggestions, orchestration.",
  },
  conversation: {
    title: "Conversation",
    blurb: "The workhorse that answers the user and (later) uses tools.",
  },
  escalation: {
    title: "Escalation",
    blurb: "Heavyweight — called in when the conversation model is stuck.",
  },
  failover: {
    title: "Failover",
    blurb: "Used when a model errors — ideally a different provider.",
  },
};

export interface RoleConfig {
  credentialId: string;
  provider: ProviderId;
  model: string;
  /** Provider-native reasoning level (see ChatRequest.reasoning) — the default
   *  "quick" level used unless the user toggles extended thinking. */
  reasoning?: string;
  /** Conversation role only: the deeper "thinking" level the user can toggle on
   *  in chat. Unset → no toggle is offered (a single fixed level). */
  reasoningExtended?: string;
}

export interface AssistantConfig {
  name: string;
  /** Branding-asset filename served via /api/branding/[name]. */
  logo?: string;
  /** Admin-written standing instructions (Admin → Customise): who this
   *  assistant is, what the company does, tone, house rules. Per instance,
   *  because each instance has its own database. */
  systemPrompt?: string;
  roles: Partial<Record<AssistantRole, RoleConfig>>;
}

export const DEFAULT_ASSISTANT_NAME = "AI Assistant";

/** Generous ceiling for the admin's standing instructions. Long enough for
 *  real house rules, short enough that it can't crowd out the conversation. */
export const MAX_SYSTEM_PROMPT_CHARS = 8_000;

export async function getAssistantConfig(): Promise<AssistantConfig> {
  const cfg = await getSetting<AssistantConfig>(SETTING_KEYS.assistant);
  return {
    name: cfg?.name || DEFAULT_ASSISTANT_NAME,
    logo: cfg?.logo,
    systemPrompt: cfg?.systemPrompt,
    roles: cfg?.roles ?? {},
  };
}

/**
 * The assistant's standing system block — the FIRST thing every user-facing
 * role sees (conversation, escalation, failover; not the front-end role, which
 * only writes titles and follow-ups).
 *
 * The identity line is always present: without it the model was never told its
 * own name, so "who are you?" got a generic answer even on a fully branded
 * instance. The admin's instructions follow it. Pure — unit-tested.
 */
export function buildAssistantSystemBlock(cfg: {
  name?: string;
  systemPrompt?: string;
}): string {
  const name = cfg.name?.trim() || DEFAULT_ASSISTANT_NAME;
  const identity = `You are ${name}, the AI assistant for this organisation's private portal.`;
  const custom = cfg.systemPrompt?.trim();
  return custom ? `${identity}\n\n${custom}` : identity;
}

export async function setAssistantConfig(cfg: AssistantConfig): Promise<void> {
  await setSetting(SETTING_KEYS.assistant, cfg);
}

/** The role that answers the user; null until an admin configures it. */
export function conversationRole(cfg: AssistantConfig): RoleConfig | null {
  return cfg.roles.conversation ?? null;
}

/** Lightweight identity for the chat client (no secrets). */
export async function getAssistantIdentity(): Promise<{
  name: string;
  logo?: string;
  configured: boolean;
  canThinkHard: boolean;
}> {
  const cfg = await getAssistantConfig();
  return {
    name: cfg.name,
    logo: cfg.logo,
    configured: !!cfg.roles.conversation,
    // The "think harder" toggle appears only when an extended level is set.
    canThinkHard: !!cfg.roles.conversation?.reasoningExtended,
  };
}

/** Resolve a role, falling back to the conversation role where sensible. */
export function roleOrConversation(
  cfg: AssistantConfig,
  role: AssistantRole,
): RoleConfig | null {
  return cfg.roles[role] ?? cfg.roles.conversation ?? null;
}
