import type { ProviderId } from "./types";

/** Human-facing metadata for each provider id, used by the credential UI. */
export interface ProviderInfo {
  id: ProviderId;
  /** Short label shown in pickers and credential lists. */
  label: string;
  /** Helper text describing what secret to paste. */
  hint: string;
  /** Vendor grouping label for the model picker (both Anthropic ids share one). */
  vendor: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    hint: "API key from platform.openai.com (starts with sk-…).",
    vendor: "OpenAI",
  },
  "anthropic-api": {
    id: "anthropic-api",
    label: "Anthropic (API key)",
    hint: "Console API key from console.anthropic.com (starts with sk-ant-…).",
    vendor: "Anthropic",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    hint: "API key from aistudio.google.com.",
    vendor: "Google",
  },
};

/** Providers a user can add a credential for via the settings form. */
export const SELECTABLE_PROVIDERS: ProviderInfo[] = [
  PROVIDER_INFO.openai,
  PROVIDER_INFO["anthropic-api"],
  PROVIDER_INFO.google,
];

export function providerLabel(id: ProviderId): string {
  return PROVIDER_INFO[id]?.label ?? id;
}

export function providerVendor(id: ProviderId): string {
  return PROVIDER_INFO[id]?.vendor ?? id;
}
