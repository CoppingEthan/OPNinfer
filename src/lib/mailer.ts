import "server-only";
import nodemailer from "nodemailer";
import { getSetting, SETTING_KEYS } from "./settings";
import { decrypt } from "./crypto";

/**
 * SMTP configuration, sourced from the admin-managed `settings` table first
 * (spec §9), falling back to environment variables. When neither is present
 * (typical local dev), email sending degrades to a console log so invite /
 * reset links remain reachable — this is what drives dev auto-verify (§5).
 */
export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
}

/**
 * Read the stored relay password, whichever way it was written.
 *
 * `passwordEncrypted` is the current form (AES-GCM, master key). `password` is
 * the old plaintext one — every other admin secret was encrypted, but this one
 * sat in the clear in `settings`, and therefore in the clear inside every
 * backup zip, where a leaked copy WORKS (provider keys don't, without the
 * master key). Existing installs keep working and are re-encrypted the next
 * time an admin saves the form.
 */
export function readStoredSmtpPassword(
  stored: { password?: string; passwordEncrypted?: string } | null | undefined,
): string | undefined {
  if (stored?.passwordEncrypted) {
    try {
      return decrypt(Buffer.from(stored.passwordEncrypted, "base64"));
    } catch {
      // Wrong master key (a backup restored elsewhere) — treat as unset rather
      // than throwing on every send.
      return undefined;
    }
  }
  return stored?.password || undefined;
}

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const stored = await getSetting<
    Partial<SmtpSettings> & { passwordEncrypted?: string }
  >(SETTING_KEYS.smtp);
  if (stored?.host && stored.from) {
    return {
      host: stored.host,
      port: stored.port ?? 587,
      secure: stored.secure ?? false,
      username: stored.username,
      password: readStoredSmtpPassword(stored),
      from: stored.from,
    };
  }

  if (process.env.SMTP_HOST && process.env.SMTP_FROM) {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      username: process.env.SMTP_USER,
      password: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM,
    };
  }

  return null;
}

export async function isSmtpConfigured(): Promise<boolean> {
  return (await getSmtpSettings()) !== null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  delivered: boolean;
}

function buildTransport(smtp: SmtpSettings) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth:
      smtp.username && smtp.password
        ? { user: smtp.username, pass: smtp.password }
        : undefined,
  });
}

export async function sendMail(msg: MailMessage): Promise<SendResult> {
  const smtp = await getSmtpSettings();

  if (!smtp) {
    // Dev fallback — no SMTP configured. Surface the content so links work.
    console.warn(
      `[mailer] No SMTP configured; email NOT sent.\n` +
        `  To:      ${msg.to}\n` +
        `  Subject: ${msg.subject}\n` +
        `  Body:\n${msg.text}\n`,
    );
    return { delivered: false };
  }

  const transport = buildTransport(smtp);
  await transport.sendMail({
    from: smtp.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  return { delivered: true };
}

/** Send a test message to verify SMTP settings (admin "Test-send", §9). */
export async function sendTestMail(to: string): Promise<SendResult> {
  return sendMail({
    to,
    subject: "OPNinfer SMTP test",
    text: "This is a test email from OPNinfer. Your SMTP settings work.",
  });
}
