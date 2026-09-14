"use server";

import { Role } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { announceChatsDeleted, announcePeople, membersOfChats } from "@/lib/sharing";
import { generateToken } from "@/lib/tokens";
import { sendMail, sendTestMail, isSmtpConfigured } from "@/lib/mailer";
import { setAlertConfig, sendTestAlert } from "@/lib/alerts";
import {
  getWeeklyReportConfig,
  setWeeklyReportConfig,
  sendWeeklyReport,
  WEEKDAYS,
  type Weekday,
} from "@/lib/weekly-report";
import { setTokenLimits, LIMIT_BOUNDS } from "@/lib/limits";
import { appUrl } from "@/lib/app-url";
import { audit } from "@/lib/audit";
import { issueTemporaryPassword } from "@/lib/temp-password";
import { encrypt } from "@/lib/crypto";
import { readStoredSmtpPassword } from "@/lib/mailer";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { getBranding, setBranding } from "@/lib/branding";
import {
  deleteBrandingAsset,
  deleteAvatarAsset,
  deleteLegacyUserDir,
  purgeConversationStorage,
} from "@/lib/storage";
import { emailSchema, passwordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/hash";
import { inviteEmail } from "@/lib/emails";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InviteResult {
  error?: string;
  /** Acceptance link — surfaced so admins can copy it (and for dev w/o SMTP). */
  link?: string;
  emailed?: boolean;
}

const inviteSchema = z.object({
  email: emailSchema,
  role: z.nativeEnum(Role).default(Role.user),
});

/**
 * Issue an invite (admin only). Access is invite-only (overrides spec §5):
 * an admin invites by email, the recipient sets their password via the link.
 */
export async function createInvite(
  _prev: InviteResult,
  formData: FormData,
): Promise<InviteResult> {
  const admin = await requireAdmin();

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role") ?? Role.user,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { email, role } = parsed.data;

  if (await db.user.findUnique({ where: { email } })) {
    return { error: "A user with that email already exists." };
  }

  const { raw, hash } = generateToken();
  const invite = await db.invite.create({
    data: {
      email,
      role,
      tokenHash: hash,
      invitedById: admin.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const link = appUrl(`/invite/${raw}`);
  const mail = await inviteEmail(link, role);
  const { delivered } = await sendMail({
    to: email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });

  await audit("invite.create", {
    userId: admin.id,
    details: { inviteId: invite.id, email, role, emailed: delivered },
  });
  revalidatePath("/admin", "layout");

  return { link, emailed: delivered };
}

/** Revoke a pending (unaccepted) invite. */
export async function deleteInvite(inviteId: string): Promise<void> {
  const admin = await requireAdmin();
  await db.invite.deleteMany({ where: { id: inviteId, acceptedAt: null } });
  await audit("invite.delete", {
    userId: admin.id,
    details: { inviteId },
  });
  revalidatePath("/admin", "layout");
}

/** Re-issue a pending invite: fresh token + 7-day expiry, re-emailed. */
export async function resendInvite(inviteId: string): Promise<InviteResult> {
  const admin = await requireAdmin();
  const invite = await db.invite.findFirst({
    where: { id: inviteId, acceptedAt: null },
  });
  if (!invite) return { error: "Invite not found or already accepted." };

  const { raw, hash } = generateToken();
  await db.invite.update({
    where: { id: invite.id },
    data: { tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });

  const link = appUrl(`/invite/${raw}`);
  const mail = await inviteEmail(link, invite.role);
  const { delivered } = await sendMail({
    to: invite.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });

  await audit("invite.resend", {
    userId: admin.id,
    details: { inviteId, email: invite.email, emailed: delivered },
  });
  revalidatePath("/admin", "layout");
  return { link, emailed: delivered };
}

/** Manually mark a user verified without sending email (admin approve). */
export async function approveUser(userId: string): Promise<void> {
  const admin = await requireAdmin();
  await db.user.update({
    where: { id: userId },
    data: { emailVerified: new Date() },
  });
  await audit("user.approve", { userId: admin.id, details: { targetUserId: userId } });
  revalidatePath("/admin", "layout");
}

/** Enable/disable a user (disabled users can't sign in). Can't disable self. */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
): Promise<{ error?: string }> {
  const admin = await requireAdmin();
  if (userId === admin.id) {
    return { error: "You can't disable your own account." };
  }
  await db.user.update({ where: { id: userId }, data: { disabled } });
  await audit("user.set_disabled", {
    userId: admin.id,
    details: { targetUserId: userId, disabled },
  });
  revalidatePath("/admin", "layout");
  return {};
}

/** Change a user's role. Refuses to remove the last admin. */
export async function setUserRole(
  userId: string,
  role: Role,
): Promise<{ error?: string }> {
  const admin = await requireAdmin();

  if (role === Role.user) {
    const target = await db.user.findUnique({ where: { id: userId } });
    if (target?.role === Role.admin) {
      const adminCount = await db.user.count({ where: { role: Role.admin } });
      if (adminCount <= 1) {
        return { error: "Can't demote the only remaining admin." };
      }
    }
  }

  await db.user.update({ where: { id: userId }, data: { role } });
  await audit("user.set_role", {
    userId: admin.id,
    details: { targetUserId: userId, role },
  });
  revalidatePath("/admin", "layout");
  return {};
}

const updateUserSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: emailSchema.optional(),
  password: z.string().optional(),
});

export interface UpdateUserState {
  error?: string;
  success?: string;
}

/** Edit a user's profile (admin): display name, email, and/or password. */
export async function updateUser(
  userId: string,
  input: { name?: string; email?: string; password?: string },
): Promise<UpdateUserState> {
  const admin = await requireAdmin();

  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { name, email, password } = parsed.data;

  const data: {
    name?: string | null;
    email?: string;
    passwordHash?: string;
    passwordChangedAt?: Date;
    mustChangePassword?: boolean;
  } = {};
  if (name !== undefined) data.name = name === "" ? null : name;
  if (email !== undefined) {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing && existing.id !== userId) {
      return { error: "That email is already in use." };
    }
    data.email = email;
  }
  if (password !== undefined && password !== "") {
    const pw = passwordSchema.safeParse(password);
    if (!pw.success) {
      return { error: pw.error.issues[0]?.message ?? "Invalid password." };
    }
    data.passwordHash = await hashPassword(password);
    data.passwordChangedAt = new Date();
    // A password chosen by someone else is temporary: they can sign in with
    // it and then must pick their own. Not applied to an admin setting their
    // OWN — being marched to a change screen after deliberately choosing a
    // password would be absurd.
    data.mustChangePassword = userId !== admin.id;
  }

  if (Object.keys(data).length === 0) {
    return { error: "Nothing to change." };
  }

  await db.user.update({ where: { id: userId }, data });
  await audit("user.update", {
    userId: admin.id,
    details: { targetUserId: userId, fields: Object.keys(data) },
  });
  revalidatePath("/admin", "layout");
  return { success: "User updated." };
}

/**
 * Generate a fresh random password for a user and store it as TEMPORARY.
 *
 * The password is always returned to the admin, whether or not it was
 * emailed. That changed on 2026-09-07: it used to be shown only when the
 * email FAILED, on the reasoning that a delivered mail needs no fallback —
 * but in practice the mail is delivered to the recipient's server and then
 * blocked or filtered there, so the admin was left with no way to help
 * beyond sending it again. Whoever can reset an account can already read
 * every chat in it; withholding the string they just generated protected
 * nothing and cost real support time.
 *
 * `sendEmail: false` skips the mail entirely — for handing it over in person,
 * over the phone, or through a channel that actually arrives.
 *
 * Either way the password is marked `mustChangePassword`, so it works exactly
 * once and the person then chooses their own: a password a second person
 * knows must not stay live.
 */
export async function adminResetPassword(
  userId: string,
  opts: { sendEmail?: boolean } = {},
): Promise<{ error?: string; emailed?: boolean; password?: string; email?: string }> {
  const admin = await requireAdmin();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "User not found." };

  // One implementation, shared with the login screen's automatic offer
  // (lib/temp-password.ts) — the rules about what a temporary password is
  // must not exist twice.
  const issued = await issueTemporaryPassword(userId, opts);
  if (!issued) return { error: "User not found." };
  const { password, emailed: delivered } = issued;

  await audit("user.password_reset", {
    userId: admin.id,
    details: { targetUserId: userId, emailed: delivered, temporary: true },
  });
  revalidatePath("/admin", "layout");
  return { emailed: delivered, password, email: user.email };
}

/** Delete a non-admin user (admin only). Their chats cascade; usage is kept
 *  (anonymised). Admin accounts must be demoted to user first. */
export async function deleteUser(userId: string): Promise<{ error?: string }> {
  const admin = await requireAdmin();
  if (userId === admin.id) return { error: "You can't delete your own account." };

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: "User not found." };
  if (target.role === "admin") {
    return { error: "Admin accounts can't be deleted here — demote to user first." };
  }

  // Capture the on-disk footprint before the cascade removes the rows: every
  // chat's storage pool, any legacy per-user uploads, and their avatar.
  const convos = await db.conversation.findMany({
    where: { userId },
    select: { id: true, files: { select: { storagePath: true } } },
  });
  // Shared chats (v0.5): chats they OWNED go with them, and everyone in those
  // is told; chats they were a MEMBER of keep their uploads (re-stamped to the
  // owner — files belong to the chat) and drop their membership.
  const ownedMembers = await membersOfChats(convos.map((c) => c.id));
  const memberships = await db.conversationMember.findMany({
    where: { userId, conversation: { userId: { not: userId } } },
    select: { conversationId: true, conversation: { select: { userId: true } } },
  });
  for (const m of memberships) {
    await db.file.updateMany({
      where: { conversationId: m.conversationId, userId },
      data: { userId: m.conversation.userId },
    });
  }

  await db.user.delete({ where: { id: userId } });

  await purgeConversationStorage(convos);
  announceChatsDeleted(ownedMembers);
  for (const m of memberships) await announcePeople(m.conversationId);
  await deleteLegacyUserDir(userId);
  if (target.image) await deleteAvatarAsset(target.image);

  await audit("user.delete", {
    userId: admin.id,
    details: { targetUserId: userId, email: target.email },
  });
  revalidatePath("/admin", "layout");
  return {};
}

// ---------------------------------------------------------------------------
// SMTP settings (spec §9). Stored in the `settings` table; sourced by mailer.
// ---------------------------------------------------------------------------

const smtpSchema = z.object({
  host: z.string().trim().min(1, "Host is required."),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().optional(),
  password: z.string().optional(),
  from: z.string().trim().email("From must be a valid email address."),
});

export interface SmtpFormState {
  error?: string;
  success?: string;
}

export async function saveSmtpSettings(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  const admin = await requireAdmin();

  const parsed = smtpSchema.safeParse({
    host: formData.get("host"),
    port: formData.get("port"),
    secure: formData.get("secure") === "on",
    username: formData.get("username") || undefined,
    password: formData.get("password") || undefined,
    from: formData.get("from"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid SMTP settings." };
  }

  // The password field renders as "•••••• (unchanged)" when one is stored, so a
  // blank submission means "leave it alone" — but `setSetting` replaces the
  // whole row, so it used to mean "delete it". An admin who changed the From
  // address or ticked TLS silently wiped the relay password, `sendMail` then
  // failed on authentication, and every invite and password-reset email stopped
  // being delivered — the one route by which migrated users regain access.
  // Same merge `saveCapability` already does for its secret fields.
  const stored = await getSetting<{ password?: string; passwordEncrypted?: string }>(
    SETTING_KEYS.smtp,
  );
  const password = parsed.data.password ?? readStoredSmtpPassword(stored);

  await setSetting(SETTING_KEYS.smtp, {
    ...parsed.data,
    // Encrypted at rest, like every other admin secret. It was the one credential
    // sitting in plaintext in `settings` — and therefore in plaintext inside
    // every backup zip, where a leaked copy works immediately (unlike provider
    // keys, which are useless without the master key).
    password: undefined,
    passwordEncrypted: password
      ? encrypt(password).toString("base64")
      : undefined,
  });
  await audit("settings.smtp_save", {
    userId: admin.id,
    details: { host: parsed.data.host, from: parsed.data.from },
  });
  revalidatePath("/admin", "layout");
  return { success: "SMTP settings saved." };
}

export async function sendTestEmail(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  await requireAdmin();
  const to = emailSchema.safeParse(formData.get("to"));
  if (!to.success) return { error: "Enter a valid recipient email." };

  try {
    const { delivered } = await sendTestMail(to.data);
    return delivered
      ? { success: `Test email sent to ${to.data}.` }
      : { error: "No SMTP configured — email was logged to the server console." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send test email." };
  }
}

// ---------------------------------------------------------------------------
// Token limits: instance-wide output/input ceilings for every model call.
// ---------------------------------------------------------------------------

export interface LimitsFormState {
  error?: string;
  success?: string;
}

export async function saveTokenLimits(
  _prev: LimitsFormState,
  formData: FormData,
): Promise<LimitsFormState> {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      maxOutputTokens: z.coerce
        .number()
        .int()
        .min(LIMIT_BOUNDS.maxOutputTokens.min)
        .max(LIMIT_BOUNDS.maxOutputTokens.max),
      maxInputTokens: z.coerce
        .number()
        .int()
        .min(LIMIT_BOUNDS.maxInputTokens.min)
        .max(LIMIT_BOUNDS.maxInputTokens.max),
      maxToolRounds: z.coerce
        .number()
        .int()
        .min(LIMIT_BOUNDS.maxToolRounds.min)
        .max(LIMIT_BOUNDS.maxToolRounds.max),
      compactAtTokens: z.coerce
        .number()
        .int()
        .min(LIMIT_BOUNDS.compactAtTokens.min)
        .max(LIMIT_BOUNDS.compactAtTokens.max),
      compactKeepTokens: z.coerce
        .number()
        .int()
        .min(LIMIT_BOUNDS.compactKeepTokens.min)
        .max(LIMIT_BOUNDS.compactKeepTokens.max),
    })
    .safeParse({
      maxOutputTokens: formData.get("maxOutputTokens"),
      maxInputTokens: formData.get("maxInputTokens"),
      maxToolRounds: formData.get("maxToolRounds"),
      compactAtTokens: formData.get("compactAtTokens"),
      compactKeepTokens: formData.get("compactKeepTokens"),
    });
  if (!parsed.success) {
    return {
      error:
        `Output must be ${LIMIT_BOUNDS.maxOutputTokens.min.toLocaleString()}–` +
        `${LIMIT_BOUNDS.maxOutputTokens.max.toLocaleString()} tokens, input ` +
        `${LIMIT_BOUNDS.maxInputTokens.min.toLocaleString()}–` +
        `${LIMIT_BOUNDS.maxInputTokens.max.toLocaleString()} tokens, and tool ` +
        `rounds ${LIMIT_BOUNDS.maxToolRounds.min}–${LIMIT_BOUNDS.maxToolRounds.max}; ` +
        `compact at ${LIMIT_BOUNDS.compactAtTokens.min.toLocaleString()}–` +
        `${LIMIT_BOUNDS.compactAtTokens.max.toLocaleString()} and keep recent ` +
        `${LIMIT_BOUNDS.compactKeepTokens.min.toLocaleString()}–` +
        `${LIMIT_BOUNDS.compactKeepTokens.max.toLocaleString()}.`,
    };
  }
  // The two compaction numbers must make sense together: the trigger under
  // the hard input ceiling, the kept tail small enough to leave room for the
  // summary. `setTokenLimits` would clamp silently; say it instead.
  if (parsed.data.compactAtTokens > parsed.data.maxInputTokens) {
    return { error: "Compact conversations at must not be above Max input tokens." };
  }
  if (parsed.data.compactKeepTokens > parsed.data.compactAtTokens / 2) {
    return { error: "Keep recent must be no more than half of Compact conversations at." };
  }

  await setTokenLimits(parsed.data);
  await audit("settings.limits_save", { userId: admin.id, details: parsed.data });
  revalidatePath("/admin", "layout");
  return {
    success:
      `Limits saved — ${parsed.data.maxOutputTokens.toLocaleString()} out, ` +
      `${parsed.data.maxInputTokens.toLocaleString()} in, ` +
      `${parsed.data.maxToolRounds} tool round${parsed.data.maxToolRounds === 1 ? "" : "s"}, ` +
      `compact at ${parsed.data.compactAtTokens.toLocaleString()} keeping ` +
      `${parsed.data.compactKeepTokens.toLocaleString()}.`,
  };
}

// ---------------------------------------------------------------------------
// Error alerts: email an address whenever the portal logs an error.
// ---------------------------------------------------------------------------

const alertSchema = z.object({
  enabled: z.boolean(),
  email: z.string().trim(),
  throttleMinutes: z.coerce.number().int().min(1).max(1440),
});

export async function saveAlertSettings(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  const admin = await requireAdmin();

  const parsed = alertSchema.safeParse({
    enabled: formData.get("alertsEnabled") === "on",
    email: formData.get("alertEmail") ?? "",
    throttleMinutes: formData.get("throttleMinutes") || 15,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid alert settings." };
  }

  // Switching alerts ON demands a real address; switching them off may leave
  // the field blank without complaint.
  if (parsed.data.enabled) {
    const email = emailSchema.safeParse(parsed.data.email);
    if (!email.success) {
      return { error: "Enter a valid email address to send alerts to." };
    }
    if (!(await isSmtpConfigured())) {
      return {
        error:
          "Configure SMTP above first — without it, alerts can't be delivered.",
      };
    }
  }

  await setAlertConfig(parsed.data);
  await audit("settings.alerts_save", {
    userId: admin.id,
    details: { enabled: parsed.data.enabled, email: parsed.data.email },
  });
  revalidatePath("/admin", "layout");
  return {
    success: parsed.data.enabled
      ? `Error alerts will be sent to ${parsed.data.email}.`
      : "Error alerts are switched off.",
  };
}

export async function sendAlertTest(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  await requireAdmin();
  const to = emailSchema.safeParse(formData.get("alertEmail"));
  if (!to.success) return { error: "Enter a valid email address first." };
  if (!(await isSmtpConfigured())) {
    return { error: "No SMTP configured — nothing can be delivered yet." };
  }

  try {
    await sendTestAlert(to.data);
    return { success: `Test alert sent to ${to.data}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send the test alert." };
  }
}

// ---------------------------------------------------------------------------
// Weekly report: a Friday digest of spend, errors and health.
// ---------------------------------------------------------------------------

const weeklyReportSchema = z.object({
  enabled: z.boolean(),
  email: z.string().trim(),
  weekday: z.enum(WEEKDAYS as [Weekday, ...Weekday[]]),
  hourLocal: z.coerce.number().int().min(0).max(23),
});

export async function saveWeeklyReportSettings(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  const admin = await requireAdmin();

  const parsed = weeklyReportSchema.safeParse({
    enabled: formData.get("reportEnabled") === "on",
    email: formData.get("reportEmail") ?? "",
    weekday: formData.get("reportWeekday") || "Fri",
    hourLocal: formData.get("reportHour") || 17,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid report settings." };
  }

  if (parsed.data.enabled) {
    const email = emailSchema.safeParse(parsed.data.email);
    if (!email.success) return { error: "Enter a valid email address for the report." };
    if (!(await isSmtpConfigured())) {
      return { error: "Configure SMTP above first — without it, the report can't be delivered." };
    }
  }

  // Preserve the send history: clearing it would make an already-sent report
  // due all over again on the next tick.
  const existing = await getWeeklyReportConfig();
  await setWeeklyReportConfig({
    ...existing,
    ...parsed.data,
    timeZone: existing.timeZone,
  });
  await audit("settings.weekly_report_save", {
    userId: admin.id,
    details: { enabled: parsed.data.enabled, weekday: parsed.data.weekday, hour: parsed.data.hourLocal },
  });
  revalidatePath("/admin", "layout");
  return {
    success: parsed.data.enabled
      ? `Weekly report will be sent to ${parsed.data.email} at ${String(parsed.data.hourLocal).padStart(2, "0")}:00 on ${parsed.data.weekday}.`
      : "The weekly report is switched off.",
  };
}

export async function sendWeeklyReportNow(
  _prev: SmtpFormState,
  formData: FormData,
): Promise<SmtpFormState> {
  await requireAdmin();
  const to = emailSchema.safeParse(formData.get("reportEmail"));
  if (!to.success) return { error: "Enter a valid email address first." };
  if (!(await isSmtpConfigured())) {
    return { error: "No SMTP configured — nothing can be delivered yet." };
  }
  try {
    // Marked TEST in the subject and body — the numbers are this week's real
    // ones, but the scheduled Friday send is the only un-marked one.
    await sendWeeklyReport(to.data, new Date(), { test: true });
    return { success: `Test report sent to ${to.data}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send the report." };
  }
}

// ---------------------------------------------------------------------------
// Branding (spec §9): accent colour + uploaded logo. Images are uploaded via
// POST /api/branding (which returns a name); these actions persist the choices.
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface BrandingFormState {
  error?: string;
  success?: string;
}

export async function saveBrandingColors(
  _prev: BrandingFormState,
  formData: FormData,
): Promise<BrandingFormState> {
  const admin = await requireAdmin();
  const accent = (formData.get("accent") as string)?.trim() || "";
  const accentDark = (formData.get("accentDark") as string)?.trim() || "";

  if (accent && !HEX.test(accent)) return { error: "Accent must be a hex colour like #b74b7a." };
  if (accentDark && !HEX.test(accentDark)) return { error: "Dark accent must be a hex colour like #d8769f." };

  await setBranding({
    accent: accent || undefined,
    accentDark: accentDark || undefined,
  });
  await audit("branding.colors", { userId: admin.id, details: { accent, accentDark } });
  revalidatePath("/", "layout"); // accent is injected in the root layout
  return { success: "Colours saved." };
}

/** Persist a freshly-uploaded logo asset name (and drop the previous one). */
export async function setBrandingLogo(name: string): Promise<void> {
  const admin = await requireAdmin();
  const current = await getBranding();
  if (current.logo && current.logo !== name) {
    await deleteBrandingAsset(current.logo);
  }
  await setBranding({ logo: name });
  await audit("branding.logo_set", { userId: admin.id, details: { name } });
  revalidatePath("/", "layout");
}

export async function clearBrandingLogo(): Promise<void> {
  const admin = await requireAdmin();
  const current = await getBranding();
  if (current.logo) await deleteBrandingAsset(current.logo);
  await setBranding({ logo: undefined });
  await audit("branding.logo_clear", { userId: admin.id });
  revalidatePath("/", "layout");
}
