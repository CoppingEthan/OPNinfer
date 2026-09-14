"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { appLog } from "@/lib/applog";
import { signOut } from "@/auth";
import { hashPassword, verifyPassword } from "@/lib/hash";
import { passwordSchema } from "@/lib/validation";
import { deleteAvatarAsset } from "@/lib/storage";

/** Remove the signed-in user's profile picture (spec: user settings). */
export async function clearProfileImage(): Promise<void> {
  const user = await requireUser();
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { image: true },
  });
  if (!row?.image) return;

  await db.user.update({ where: { id: user.id }, data: { image: null } });
  await deleteAvatarAsset(row.image);
  await audit("user.avatar_clear", { userId: user.id });
  revalidatePath("/chat");
}

export interface ChangePasswordState {
  error?: string;
}

/**
 * Change your own password, from the settings panel or the forced screen.
 *
 * Why this exists (2026-09-07): password-reset emails are being DELIVERED and
 * then blocked at the recipient's end, so the operator hands a password over
 * by another route. That password is temporary by construction
 * (`mustChangePassword`) and this is the only way to clear it. Nothing here
 * touches email.
 *
 * A FORM ACTION, not a callback the client invokes. The first version was an
 * `onSubmit` handler, and when a click landed before React had hydrated the
 * browser did what browsers do with an un-intercepted form: submitted it
 * natively as a GET, putting `?current=…&password=…` in the address bar, the
 * history, and the server log. A form action is a POST whether or not the
 * page has hydrated.
 *
 * THE CURRENT PASSWORD IS REQUIRED, including on the forced screen. Someone
 * who walks up to an unlocked laptop must not be able to lock the owner out
 * of their account in two clicks, and the person going through the forced
 * flow typed the temporary password moments ago.
 *
 * On success every session ends — including this one — and the person is sent
 * to sign in again. That is not a wrinkle to work around but the point:
 * `passwordChangedAt` is what the 60-second session recheck compares against,
 * so a change already invalidates every token issued before it (audit
 * 2026-09-05). Doing it immediately and saying so beats the alternative,
 * which is being mysteriously signed out within the minute — and it stops the
 * temporary password the admin knows from working anywhere.
 */
export async function changeOwnPassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next !== confirm) return { error: "The two new passwords do not match." };

  const parsed = passwordSchema.safeParse(next);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid password." };
  }

  const user = await db.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) return { error: "Account not found." };

  if (!(await verifyPassword(user.passwordHash, current))) {
    void appLog("warn", "auth", "Failed password change — wrong current password.", {
      userId: user.id,
      details: { email: user.email },
    }).catch(() => {});
    return { error: "That is not your current password." };
  }

  if (await verifyPassword(user.passwordHash, next)) {
    return { error: "Choose a password different from your current one." };
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(next),
      passwordChangedAt: new Date(),
      // Whatever was set for them is now theirs.
      mustChangePassword: false,
    },
  });

  await audit("user.password_change", { userId: user.id });
  void appLog("info", "auth", "Password changed.", {
    userId: user.id,
    details: { email: user.email },
  }).catch(() => {});

  // The login screen already says "Password updated — please sign in."
  await signOut({ redirectTo: "/login?reset=1" });
  return {};
}
