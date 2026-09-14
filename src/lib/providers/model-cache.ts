import type { Model } from "./types";

/**
 * Per-credential model cache (spec §6): results cached for 1 hour in memory,
 * re-fetched on credential save and manual admin refresh (via `invalidate`).
 * In-memory is sufficient for single-instance deployment (spec §1).
 */
const TTL_MS = 60 * 60 * 1000;

interface Entry {
  models: Model[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export function getCachedModels(credentialId: string): Model[] | null {
  const entry = cache.get(credentialId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(credentialId);
    return null;
  }
  return entry.models;
}

export function setCachedModels(credentialId: string, models: Model[]): void {
  cache.set(credentialId, { models, expiresAt: Date.now() + TTL_MS });
}

export function invalidateModels(credentialId: string): void {
  cache.delete(credentialId);
}
