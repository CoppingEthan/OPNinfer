"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/hash";
import { generateToken, hashToken } from "@/lib/tokens";
import { sendMail } from "@/lib/mailer";
import { resetEmail } from "@/lib/emails";
import { appUrl } from "@/lib/app-url";
import { emailSchema, setPasswordSchema } from "@/lib/validation";
import { loginBlockedMs, loginFailureCount, loginKey, recordLoginFailure } from "@/lib/login-guard";
import { claimRecoverySend, shouldIssueRecoveryPassword } from "@/lib/recovery";
import { issueTemporaryPassword } from "@/lib/temp-password";
import { headers } from "next/headers";
import { appLog } from "@/lib/applog";

export interface FormState {
  error?: string;
  success?: string;
  /** A temporary password was just emailed because this account has never
   *  been signed in to. Rendered as guidance, not as an error. */
  recovery?: { email: string; emailed: boolean };
}

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour (spec §5)

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function authenticate(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const callbackUrl = (formData.get("callbackUrl") as string) || "/";
  const typedEmail = String(formData.get("email") ?? "");
  try {
    await signIn("credentials", {
      email: typedEmail,
      password: formData.get("password"),
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      const recovery = await offerRecoveryPassword(typedEmail);
      if (recovery) return { recovery };
      return { error: "Invalid email or password, or your account is inactive." };
    }
    // signIn's redirect throws NEXT_REDIRECT — must propagate.
    throw error;
  }
  return {};
}

/**
 * After a run of failures, hand an account that has NEVER been signed in to a
 * temporary password (owner ask, 2026-09-09).
 *
 * The problem it solves is not that people cannot find the reset button — it
 * is that the link it sends expires in an hour, and these emails are being
 * held in the recipient's spam or quarantine for longer than that. Every
 * unused reset link on the estate had expired. A temporary password does not
 * expire, so it still works whenever they dig the mail out.
 *
 * `lib/recovery.ts` holds the rule and the reasons each clause is there; the
 * one that matters is `lastSignInAt === null`, because issuing a password
 * REPLACES the current one and must never happen to somebody who was using
 * it. Silent on every failure path: a login screen must not become a way to
 * find out which addresses have accounts, or to make us send mail on demand.
 */
async function offerRecoveryPassword(
  rawEmail: string,
): Promise<{ email: string; emailed: boolean } | undefined> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return undefined;
  const email = parsed.data.toLowerCase().trim();

  try {
    // The same bucket `authorize` just recorded the failure in, so the count
    // is the real one. Read, never bumped — asking must not lock anyone out.
    const forwarded = (await headers()).get("x-forwarded-for");
    const clientIp = forwarded ? forwarded.split(",")[0]?.trim() : null;
    const failures = loginFailureCount(loginKey(email, clientIp));

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, disabled: true, emailVerified: true, lastSignInAt: true },
    });
    const eligible = shouldIssueRecoveryPassword({
      failures,
      exists: !!user,
      disabled: !!user?.disabled,
      verified: !!user?.emailVerified,
      lastSignInAt: user?.lastSignInAt ?? null,
    });
    if (!eligible || !user) return undefined;

    // One per account per half hour, however many times they try.
    if (!claimRecoverySend(email)) return undefined;

    const issued = await issueTemporaryPassword(user.id);
    if (!issued) return undefined;

    void appLog("info", "auth", "Sent a temporary password after repeated failed sign-ins.", {
      userId: user.id,
      details: { email, failures, emailed: issued.emailed, reason: "never signed in here" },
    }).catch(() => {});

    return { email: issued.email, emailed: issued.emailed };
  } catch {
    // Never turn a failed sign-in into a 500 — the person is already having
    // a bad time. They simply get the ordinary message.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// First-run bootstrap: create the first admin (spec §5). Only works while
// there are zero users; after that, access is invite-only.
// ---------------------------------------------------------------------------

export async function bootstrapAdmin(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const userCount = await db.user.count();
  if (userCount > 0) {
    return { error: "Setup is already complete. Please sign in." };
  }

  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) {
    return { error: email.error.issues[0]?.message ?? "Invalid email." };
  }
  const pw = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!pw.success) {
    return { error: pw.error.issues[0]?.message ?? "Invalid password." };
  }

  // Guard against a race (audit 2026-09-05): the unique email constraint only
  // stops the SAME address twice — two concurrent submissions with different
  // emails would both become admins. A transaction-scoped advisory lock
  // serialises them, and the count is re-checked inside it.
  const passwordHash = await hashPassword(pw.data.password);
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(72030901)`;
      if ((await tx.user.count()) > 0) throw new Error("setup-done");
      await tx.user.create({
        data: {
          email: email.data,
          passwordHash,
          role: "admin",
          emailVerified: new Date(),
        },
      });
    });
  } catch {
    return { error: "Could not create the admin account. Setup may already be complete." };
  }

  redirect("/login?registered=1");
}

// ---------------------------------------------------------------------------
// Accept an invite: set a password, which creates the verified account.
// ---------------------------------------------------------------------------

export async function acceptInvite(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return { error: "This invite link is invalid or has expired." };
  }

  const pw = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!pw.success) {
    return { error: pw.error.issues[0]?.message ?? "Invalid password." };
  }

  const existing = await db.user.findUnique({ where: { email: invite.email } });
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  // The invite itself is the verification — the account is created verified.
  await db.$transaction([
    db.user.create({
      data: {
        email: invite.email,
        passwordHash: await hashPassword(pw.data.password),
        role: invite.role,
        emailVerified: new Date(),
      },
    }),
    db.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    }),
  ]);

  redirect("/login?registered=1");
}

// ---------------------------------------------------------------------------
// Password reset request + completion (spec §5).
// ---------------------------------------------------------------------------

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = emailSchema.safeParse(formData.get("email"));
  // Generic response either way — never reveal whether an account exists.
  const generic: FormState = {
    success:
      "If an account exists for that email, a reset link has been sent.",
  };
  if (!email.success) return generic;

  // Throttled like sign-in (audit 2026-09-05): this is unauthenticated and
  // sends an email per call, so without a bucket anyone could flood a staff
  // inbox and our SMTP reputation from a script. Same backoff curve, its own
  // key, and silently the generic reply while blocked.
  const guardKey = loginKey(`reset:${email.data}`);
  if (loginBlockedMs(guardKey) > 0) {
    void appLog("warn", "auth", "Password reset request refused — too many recent requests.", {
      details: { email: email.data },
    }).catch(() => {});
    return generic;
  }
  recordLoginFailure(guardKey);

  const user = await db.user.findUnique({ where: { email: email.data } });
  if (!user || user.disabled) return generic;

  const { raw, hash } = generateToken();
  await db.$transaction([
    // Only the newest link works: earlier unused ones would each stay valid
    // for their full hour otherwise, and nothing ever pruned them.
    db.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
    db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    }),
  ]);

  const link = appUrl(`/reset-password/${raw}`);
  const mail = await resetEmail(link);
  await sendMail({
    to: user.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });

  return generic;
}

export async function resetPassword(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return { error: "This reset link is invalid or has expired." };
  }

  const pw = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!pw.success) {
    return { error: pw.error.issues[0]?.message ?? "Invalid password." };
  }

  await db.$transaction([
    db.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(pw.data.password),
        // Completing a reset proves email ownership.
        emailVerified: new Date(),
        // Ends every session issued before now (see the schema note).
        passwordChangedAt: new Date(),
      },
    }),
    db.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  redirect("/login?reset=1");
}
