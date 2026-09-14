import { getProvider } from "./registry";
import { getCachedModels, setCachedModels } from "./model-cache";
import type { ChatChunk, ChatRequest, Credential, Model } from "./types";

export * from "./types";
export {
  getProvider,
  isProviderImplemented,
  implementedProviderIds,
} from "./registry";
export { loadCredential, touchCredential } from "./credentials";
export { invalidateModels } from "./model-cache";
export { toProviderId, toDbProvider } from "./mapping";

export interface ModelsResult {
  models: Model[];
  source: "cache" | "live" | "fallback";
}

/**
 * Resolve the model list for a credential: cache → live list → hardcoded
 * fallback (spec §6). A failed live fetch never blocks the user.
 */
export async function getModels(creds: Credential): Promise<ModelsResult> {
  const cached = getCachedModels(creds.id);
  if (cached) return { models: cached, source: "cache" };

  const provider = getProvider(creds.provider);
  try {
    const models = await provider.listModels(creds);
    setCachedModels(creds.id, models);
    return { models, source: "live" };
  } catch {
    return { models: provider.fallbackModels(), source: "fallback" };
  }
}

/** Stream a chat completion through the right provider implementation. */
export function streamChat(
  req: ChatRequest,
  creds: Credential,
): AsyncIterable<ChatChunk> {
  return getProvider(creds.provider).streamChat(req, creds);
}
