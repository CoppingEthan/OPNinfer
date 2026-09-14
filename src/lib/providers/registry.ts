import type { Provider, ProviderId } from "./types";
import { openaiProvider } from "./openai";
import { anthropicApiProvider } from "./anthropic";
import { googleProvider } from "./google";

/**
 * Provider registry (spec §3). Each provider is one file; adding one is a
 * single import + entry.
 */
const REGISTRY: Partial<Record<ProviderId, Provider>> = {
  openai: openaiProvider,
  "anthropic-api": anthropicApiProvider,
  google: googleProvider,
};

export function getProvider(id: ProviderId): Provider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Provider "${id}" is not implemented yet.`);
  }
  return provider;
}

export function isProviderImplemented(id: ProviderId): boolean {
  return id in REGISTRY;
}

export function implementedProviderIds(): ProviderId[] {
  return Object.keys(REGISTRY) as ProviderId[];
}
