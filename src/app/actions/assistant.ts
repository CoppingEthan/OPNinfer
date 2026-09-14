"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { deleteBrandingAsset } from "@/lib/storage";
import {
  getAssistantConfig,
  setAssistantConfig,
  ASSISTANT_ROLES,
  MAX_SYSTEM_PROMPT_CHARS,
  type AssistantConfig,
} from "@/lib/assistant";

const roleSchema = z.object({
  credentialId: z.string().uuid(),
  provider: z.enum(["openai", "anthropic-api", "google"]),
  model: z.string().trim().min(1),
  reasoning: z.string().trim().max(40).optional(),
  reasoningExtended: z.string().trim().max(40).optional(),
});

export interface AssistantSaveState {
  error?: string;
  success?: string;
}

/** Persist the assistant's model roles (Models tab). Merges into the existing
 *  config so the identity (name/logo, edited under Customise) is preserved.
 *  Conversation is the minimum to go live; other roles are optional. */
export async function saveAssistantRoles(
  input: AssistantConfig["roles"],
): Promise<AssistantSaveState> {
  const admin = await requireAdmin();
  const cfg = await getAssistantConfig();

  const roles: AssistantConfig["roles"] = {};
  for (const role of ASSISTANT_ROLES) {
    const v = input?.[role];
    if (!v) continue;
    const r = roleSchema.safeParse(v);
    if (!r.success) return { error: `Check the ${role} model selection.` };
    roles[role] = {
      credentialId: r.data.credentialId,
      provider: r.data.provider,
      model: r.data.model,
      reasoning: r.data.reasoning || undefined,
      // Extended thinking applies to the conversation role only.
      reasoningExtended:
        role === "conversation" ? r.data.reasoningExtended || undefined : undefined,
    };
  }

  await setAssistantConfig({ ...cfg, roles });
  await audit("assistant.roles_save", {
    userId: admin.id,
    details: { roles: Object.keys(roles) },
  });
  revalidatePath("/admin/models");
  revalidatePath("/chat", "layout");
  return { success: "Models saved." };
}

/** Persist the assistant identity (name) — edited under Customise. The logo has
 *  its own upload/clear actions below. */
export async function saveAssistantIdentity(input: {
  name: string;
}): Promise<AssistantSaveState> {
  const admin = await requireAdmin();
  const name = (input?.name ?? "").trim();
  if (!name || name.length > 80) {
    return { error: "Give the assistant a name (1–80 characters)." };
  }
  const cfg = await getAssistantConfig();
  await setAssistantConfig({ ...cfg, name });
  await audit("assistant.identity_save", { userId: admin.id, details: { name } });
  revalidatePath("/admin/customise");
  revalidatePath("/chat", "layout");
  return { success: "Assistant identity saved." };
}

/** Persist the assistant's standing instructions (Customise → Assistant
 *  instructions). Applies to every user-facing role from the next turn — it's
 *  read fresh per turn by the chat route, so no restart is needed. */
export async function saveSystemPrompt(input: {
  systemPrompt: string;
}): Promise<AssistantSaveState> {
  const admin = await requireAdmin();
  const systemPrompt = (input?.systemPrompt ?? "").trim();
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return {
      error: `Instructions are too long (${systemPrompt.length.toLocaleString()} of ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters).`,
    };
  }
  const cfg = await getAssistantConfig();
  await setAssistantConfig({ ...cfg, systemPrompt: systemPrompt || undefined });
  // The text itself can be sensitive house policy — audit the change, not the
  // content (length is enough to see that something happened, and when).
  await audit("assistant.system_prompt_save", {
    userId: admin.id,
    details: { chars: systemPrompt.length },
  });
  revalidatePath("/admin/customise");
  return {
    success: systemPrompt ? "Instructions saved." : "Instructions cleared.",
  };
}

export async function setAssistantLogo(name: string): Promise<void> {
  const admin = await requireAdmin();
  const cfg = await getAssistantConfig();
  if (cfg.logo && cfg.logo !== name) await deleteBrandingAsset(cfg.logo);
  await setAssistantConfig({ ...cfg, logo: name });
  await audit("assistant.logo_set", { userId: admin.id, details: { name } });
  revalidatePath("/admin/models");
  revalidatePath("/chat", "layout");
}

export async function clearAssistantLogo(): Promise<void> {
  const admin = await requireAdmin();
  const cfg = await getAssistantConfig();
  if (cfg.logo) await deleteBrandingAsset(cfg.logo);
  await setAssistantConfig({ ...cfg, logo: undefined });
  await audit("assistant.logo_clear", { userId: admin.id });
  revalidatePath("/admin/models");
  revalidatePath("/chat", "layout");
}
