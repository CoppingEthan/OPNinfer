"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { verifyPassword } from "@/lib/hash";
import { audit } from "@/lib/audit";
import { appLog } from "@/lib/applog";
import {
  grantSudo,
  revokeSudo,
  lockoutRemaining,
  recordFailedAttempt,
  clearFailedAttempts,
} from "@/lib/sudo";

export interface SudoFormState {
  error?: string;
}

/**
 * Unlock the chat viewer by re-entering your own password. Every outcome is
 * recorded: a granted unlock, and every failure — reading another person's
 * conversations should never be quiet.
 */
export async function confirmSudo(
  _prev: SudoFormState,
  formData: FormData,
): Promise<SudoFormState> {
  const admin = await requireAdmin();

  const locked = lockoutRemaining(admin.id);
  if (locked > 0) {
    return {
      error: `Too many failed attempts. Try again in ${Math.ceil(locked / 60_000)} minute(s).`,
    };
  }

  const password = String(formData.get("password") ?? "");
  if (!password) return { error: "Enter your password." };

  const row = await db.user.findUnique({
    where: { id: admin.id },
    select: { passwordHash: true },
  });
  if (!row || !(await verifyPassword(row.passwordHash, password))) {
    recordFailedAttempt(admin.id);
    await appLog("warn", "admin", "Failed chat-viewer unlock", {
      userId: admin.id,
      details: { email: admin.email },
    });
    return { error: "That password is not correct." };
  }

  clearFailedAttempts(admin.id);
  await grantSudo(admin.id);
  await audit("admin.chats_unlock", { userId: admin.id });
  revalidatePath("/admin/chats");
  return {};
}

/** Lock the viewer again without waiting for the grant to expire. */
export async function lockSudo(): Promise<void> {
  const admin = await requireAdmin();
  await revokeSudo();
  await audit("admin.chats_lock", { userId: admin.id });
  revalidatePath("/admin/chats");
}
