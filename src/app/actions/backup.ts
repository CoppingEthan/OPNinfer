"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { appLog } from "@/lib/applog";
import {
  createBackup,
  deleteBackup as deleteBackupFile,
  getBackupConfig,
  setBackupConfig,
  type BackupConfig,
} from "@/lib/backup";

/** Admin: create a backup immediately. Returns the new file's name. */
export async function createBackupNow(): Promise<{
  success?: string;
  name?: string;
  error?: string;
}> {
  const admin = await requireAdmin();
  try {
    const info = await createBackup("manual");
    await audit("backup.create", {
      userId: admin.id,
      details: { name: info.name, sizeBytes: info.sizeBytes },
    });
    await appLog("info", "backup", `Manual backup created: ${info.name}`, {
      userId: admin.id,
      details: { sizeBytes: info.sizeBytes },
    });
    revalidatePath("/admin/backups");
    return { success: "Backup created.", name: info.name };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Backup failed.";
    await appLog("error", "backup", "Manual backup failed.", {
      userId: admin.id,
      details: { error: msg },
    });
    return { error: msg };
  }
}

/** Admin: delete a stored backup. */
export async function deleteBackup(
  name: string,
): Promise<{ success?: string; error?: string }> {
  const admin = await requireAdmin();
  try {
    await deleteBackupFile(name);
    await audit("backup.delete", { userId: admin.id, details: { name } });
    revalidatePath("/admin/backups");
    return { success: "Deleted." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}

/** Admin: save the auto-backup schedule. */
export async function saveBackupConfig(
  patch: Partial<BackupConfig>,
): Promise<{ success?: string; error?: string; config?: BackupConfig }> {
  const admin = await requireAdmin();

  const next: Partial<BackupConfig> = {};
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.frequency === "daily" || patch.frequency === "weekly") {
    next.frequency = patch.frequency;
  }
  if (typeof patch.hourUtc === "number") {
    if (patch.hourUtc < 0 || patch.hourUtc > 23) {
      return { error: "Hour must be between 0 and 23 (UTC)." };
    }
    next.hourUtc = Math.floor(patch.hourUtc);
  }
  if (typeof patch.retention === "number") {
    if (patch.retention < 1 || patch.retention > 365) {
      return { error: "Retention must be between 1 and 365." };
    }
    next.retention = Math.floor(patch.retention);
  }

  const config = await setBackupConfig(next);
  await audit("backup.config", {
    userId: admin.id,
    details: {
      enabled: config.enabled,
      frequency: config.frequency,
      hourUtc: config.hourUtc,
      retention: config.retention,
    },
  });
  revalidatePath("/admin/backups");
  return { success: "Saved.", config };
}

/** Admin: read the current auto-backup config (for optimistic UI refreshes). */
export async function fetchBackupConfig(): Promise<BackupConfig> {
  await requireAdmin();
  return getBackupConfig();
}
