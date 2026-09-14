import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { Credential } from "./types";
import { toProviderId } from "./mapping";

/**
 * Load a stored org credential and decrypt it for use (v0.2: credentials are
 * org-level). Returns null if not found.
 */
export async function loadCredential(
  credentialId: string,
): Promise<Credential | null> {
  const row = await db.providerCredential.findUnique({
    where: { id: credentialId },
  });
  if (!row) return null;

  return {
    id: row.id,
    provider: toProviderId(row.provider),
    secret: decrypt(Buffer.from(row.encryptedValue)),
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  };
}

/** Record that a credential was just used (spec §4 `last_used_at`). */
export async function touchCredential(credentialId: string): Promise<void> {
  await db.providerCredential.update({
    where: { id: credentialId },
    data: { lastUsedAt: new Date() },
  });
}
