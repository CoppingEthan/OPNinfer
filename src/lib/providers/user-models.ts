import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getModels } from "./index";
import { toProviderId } from "./mapping";
import { providerVendor } from "./labels";
import type { Credential, Model, ProviderId } from "./types";

/** A decrypted org credential, ready to authenticate upstream requests. */
export interface OrgCredential {
  id: string;
  label: string;
  provider: ProviderId;
  vendor: string;
  cred: Credential;
}

/** Decrypt every stored org credential (v0.2: no per-user scoping). */
export async function loadOrgCredentials(): Promise<OrgCredential[]> {
  const rows = await db.providerCredential.findMany({
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => {
    const provider = toProviderId(row.provider);
    return {
      id: row.id,
      label: row.label,
      provider,
      vendor: providerVendor(provider),
      cred: {
        id: row.id,
        provider,
        secret: decrypt(Buffer.from(row.encryptedValue)),
        metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      },
    };
  });
}

/** The models a single org credential exposes (live → fallback), for the admin
 *  assistant-config role pickers. */
export interface CredentialModels {
  credentialId: string;
  label: string;
  provider: ProviderId;
  vendor: string;
  /** False when the live list couldn't be fetched (key revoked, etc.). */
  ok: boolean;
  models: Model[];
}

/**
 * Discover the models available across all org credentials, grouped by
 * credential. Used by Admin → Models to assign a (credential, model) pair to
 * each assistant role.
 */
export async function getCredentialModels(): Promise<CredentialModels[]> {
  const creds = await loadOrgCredentials();
  return Promise.all(
    creds.map(async (c): Promise<CredentialModels> => {
      try {
        const { models } = await getModels(c.cred);
        return { credentialId: c.id, label: c.label, provider: c.provider, vendor: c.vendor, ok: true, models };
      } catch {
        return { credentialId: c.id, label: c.label, provider: c.provider, vendor: c.vendor, ok: false, models: [] };
      }
    }),
  );
}
