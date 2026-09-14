"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireAdmin } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { getProvider } from "@/lib/providers/registry";
import { toDbProvider, toProviderId } from "@/lib/providers/mapping";
import { invalidateModels } from "@/lib/providers/model-cache";
import { SELECTABLE_PROVIDERS } from "@/lib/providers/labels";
import type { Credential, ProviderId } from "@/lib/providers/types";

export interface CredentialFormState {
  error?: string;
  success?: string;
}

const SELECTABLE_IDS = SELECTABLE_PROVIDERS.map((p) => p.id) as [
  ProviderId,
  ...ProviderId[],
];

const addSchema = z.object({
  provider: z.enum(SELECTABLE_IDS),
  label: z.string().trim().min(1, "Give this key a name.").max(80),
  secret: z.string().trim().min(8, "That key looks too short."),
});

/**
 * Add an org provider credential (admin only, v0.2 central keys). The key is
 * verified against the provider's live model list before storage, so a bad key
 * is rejected immediately. Stored AES-256-GCM encrypted.
 */
export async function addCredential(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const admin = await requireAdmin();

  const parsed = addSchema.safeParse({
    provider: formData.get("provider"),
    label: formData.get("label"),
    secret: formData.get("secret"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { provider, label, secret } = parsed.data;

  // Verify the key works before persisting (live discovery doubles as a check).
  const probe: Credential = { id: "verify", provider, secret };
  try {
    await getProvider(provider).listModels(probe);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { error: `Could not verify this key with ${provider}: ${detail}` };
  }

  const created = await db.providerCredential.create({
    data: {
      userId: admin.id, // creator; org-level, survives admin deletion (SET NULL)
      provider: toDbProvider(provider),
      label,
      encryptedValue: new Uint8Array(encrypt(secret)),
    },
  });

  await audit("credential.add", {
    userId: admin.id,
    details: { credentialId: created.id, provider },
  });
  revalidatePath("/admin/api");
  return { success: `${label} added and verified.` };
}

const updateSchema = z
  .object({
    label: z.string().trim().min(1, "Give this key a name.").max(80).optional(),
    secret: z.string().trim().min(8, "That key looks too short.").optional(),
  })
  .refine((v) => v.label !== undefined || v.secret !== undefined, {
    message: "Nothing to update.",
  });

/**
 * Edit an org credential (admin only, spec §19): rename it and/or replace the
 * secret. A replacement key is verified against the provider's live model list
 * before it's re-encrypted and stored, exactly like adding a new one.
 */
export async function updateCredential(
  credentialId: string,
  input: { label?: string; secret?: string },
): Promise<CredentialFormState> {
  const admin = await requireAdmin();

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const cred = await db.providerCredential.findUnique({ where: { id: credentialId } });
  if (!cred) return { error: "Key not found." };
  const provider = toProviderId(cred.provider);

  const data: Prisma.ProviderCredentialUpdateInput = {};
  if (parsed.data.label && parsed.data.label !== cred.label) {
    data.label = parsed.data.label;
  }
  if (parsed.data.secret) {
    // Verify the replacement works before persisting it.
    const probe: Credential = { id: "verify", provider, secret: parsed.data.secret };
    try {
      await getProvider(provider).listModels(probe);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return { error: `Could not verify this key with ${provider}: ${detail}` };
    }
    data.encryptedValue = new Uint8Array(encrypt(parsed.data.secret));
  }

  if (!data.label && !data.encryptedValue) {
    return { error: "No changes to save." };
  }

  await db.providerCredential.update({ where: { id: credentialId }, data });
  if (data.encryptedValue) invalidateModels(cred.id); // key changed → refresh

  await audit("credential.update", {
    userId: admin.id,
    details: { credentialId, provider, changed: Object.keys(data) },
  });
  revalidatePath("/admin/api");
  return { success: data.encryptedValue ? "Key replaced and verified." : "Key renamed." };
}

/** Delete an org credential (admin only). */
export async function deleteCredential(credentialId: string): Promise<void> {
  const admin = await requireAdmin();

  const cred = await db.providerCredential.findUnique({
    where: { id: credentialId },
  });
  if (!cred) return; // already gone — no-op

  await db.providerCredential.delete({ where: { id: cred.id } });
  invalidateModels(cred.id);

  await audit("credential.delete", {
    userId: admin.id,
    details: { credentialId: cred.id, provider: toProviderId(cred.provider) },
  });
  revalidatePath("/admin/api");
}
