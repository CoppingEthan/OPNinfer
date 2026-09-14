import type { ProviderId } from "./types";

/**
 * Admin-selectable reasoning levels per provider (spec §6). The `value` is what
 * we store and hand to the provider's `streamChat`; "" means "provider default".
 * Each provider exposes a different control, verified June 2026:
 *  - OpenAI   → `reasoning_effort` (none·minimal·low·medium·high·xhigh)
 *  - Anthropic→ adaptive thinking + `effort` (low·high·xhigh·max; "off" disables)
 *  - Google   → `thinking_level` on Gemini 3.x (minimal·low·medium·high; "off")
 * Options are provider-level, not model-level — a non-reasoning model (e.g.
 * GPT-4.x) will reject any non-default value, so pick "Default"/"Off" there.
 */
export interface ReasoningOption {
  value: string;
  label: string;
}

export const REASONING_OPTIONS: Record<ProviderId, ReasoningOption[]> = {
  openai: [
    { value: "", label: "Default" },
    { value: "none", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
  ],
  "anthropic-api": [
    { value: "", label: "Default" },
    { value: "off", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
    { value: "max", label: "Max" },
  ],
  google: [
    { value: "", label: "Default" },
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
};

/** Reasoning options for a provider (falls back to just "Default"). */
export function reasoningOptions(provider?: ProviderId): ReasoningOption[] {
  if (!provider) return [{ value: "", label: "Default" }];
  return REASONING_OPTIONS[provider] ?? [{ value: "", label: "Default" }];
}
