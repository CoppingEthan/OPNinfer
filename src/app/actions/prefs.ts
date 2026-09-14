"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { setUsageVisibility, type UsageVisibility } from "@/lib/prefs";
import { setSetting, SETTING_KEYS, MAX_UPLOAD_CEILING } from "@/lib/settings";

/** Admin: set who sees the in-chat token/cost stats (everyone/admins/off). */
export async function saveUsageVisibility(
  v: UsageVisibility,
): Promise<{ success?: string; error?: string }> {
  const admin = await requireAdmin();
  if (v !== "everyone" && v !== "admins" && v !== "off") {
    return { error: "Invalid option." };
  }
  await setUsageVisibility(v);
  await audit("settings.usage_visibility", {
    userId: admin.id,
    details: { value: v },
  });
  revalidatePath("/admin/customise");
  revalidatePath("/chat", "layout");
  return { success: "Saved." };
}

/** Admin: set the per-file upload limit (MB). Enforced mid-stream on upload. */
export async function saveMaxUploadMb(
  mb: number,
): Promise<{ success?: string; error?: string }> {
  const admin = await requireAdmin();
  const ceilingMb = MAX_UPLOAD_CEILING / 1024 / 1024;
  if (!Number.isFinite(mb) || mb < 1 || mb > ceilingMb) {
    return { error: `Limit must be between 1 and ${ceilingMb} MB.` };
  }
  const bytes = Math.floor(mb) * 1024 * 1024;
  await setSetting(SETTING_KEYS.maxUploadBytes, bytes);
  await audit("settings.max_upload_bytes", {
    userId: admin.id,
    details: { bytes, mb: Math.floor(mb) },
  });
  revalidatePath("/admin/customise");
  return { success: "Saved." };
}
