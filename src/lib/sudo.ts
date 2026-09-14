import "server-only";
import { cookies } from "next/headers";
import { encrypt, decrypt } from "@/lib/crypto";

/**
 * Sudo mode — a short-lived re-authentication for the most sensitive admin
 * surface (reading other people's chats).
 *
 * The admin re-enters THEIR OWN password, not a shared secret. That matters
 * for three reasons the master key can't satisfy: it identifies *which* admin
 * looked (the audit log names them), it can be revoked by disabling that one
 * account, and it never puts the credential that decrypts every stored
 * provider key into a browser form.
 *
 * The grant is an encrypted, httpOnly cookie scoped to /admin — it carries the
 * admin's id and an expiry, is sealed with the instance master key (so it
 * can't be forged client-side), and is bound to the account that created it
 * (a cookie lifted from one admin is useless to another).
 */

// Namespaced per instance for the same reason the Auth.js cookies are (see
// auth.config.ts): several portals reached on one host share a cookie jar, so
// unlocking sudo on one used to clobber the grant on another. The payload is
// sealed with the instance's own master key, so a stray grant from another
// portal already failed closed — this stops it overwriting a live one.
const COOKIE = `opninfer_sudo_${
  (process.env.OPNINFER_INSTANCE || "default").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "default"
}`;
/** How long one password confirmation stays valid. */
export const SUDO_TTL_MS = 15 * 60_000;

interface SudoPayload {
  adminId: string;
  exp: number;
}

/** Issue a grant. Cookies are writable only from server actions / routes. */
export async function grantSudo(adminId: string): Promise<void> {
  const payload: SudoPayload = { adminId, exp: Date.now() + SUDO_TTL_MS };
  const jar = await cookies();
  jar.set(COOKIE, encrypt(JSON.stringify(payload)).toString("base64"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Site-wide, NOT "/admin". A browser only sends a cookie to paths matching
    // its `path`, and the chat transcript loads attachments and generated
    // images from `/api/files/<id>` — so with an /admin-scoped cookie the sudo
    // exception in that route could never fire, and an admin who unlocked a
    // chat to investigate a problem saw every file 404 and every image broken.
    // It also meant `admin.view_file`, one of only two audit events covering
    // cross-user file access, could never be written. The path was never what
    // secured this: the grant is AES-GCM sealed, bound to one admin id, and
    // expires in 15 minutes.
    path: "/",
    maxAge: Math.floor(SUDO_TTL_MS / 1000),
  });
}

/** Drop the grant (explicit lock, or after a failed check). */
export async function revokeSudo(): Promise<void> {
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/" });
  // Clear the old /admin-scoped cookie too, so a grant issued before the path
  // changed can't linger in a browser after an explicit lock.
  jar.delete({ name: COOKIE, path: "/admin" });
}

/**
 * Expiry timestamp of a valid grant for this admin, else null. Any tampering,
 * a different admin, or an elapsed expiry all fail closed.
 */
export async function sudoExpiresAt(adminId: string): Promise<number | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const payload = JSON.parse(
      decrypt(Buffer.from(raw, "base64")),
    ) as Partial<SudoPayload>;
    if (payload.adminId !== adminId) return null;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload.exp;
  } catch {
    // Unparseable / failed auth tag / wrong master key — treat as no grant.
    return null;
  }
}

export async function hasSudo(adminId: string): Promise<boolean> {
  return (await sudoExpiresAt(adminId)) !== null;
}

// ---------------------------------------------------------------------------
// Brute-force guard. In-process, matching the single-instance design; a
// wrong password is cheap to retry otherwise, and this surface is worth
// slowing down.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
// globalThis-anchored (audit 2026-09-05): the unlock action is bundled with
// both the chats list and the chat detail page; separate module instances
// would give an admin's password two independent five-try budgets.
const attempts: Map<string, { count: number; until: number }> = ((
  globalThis as { __oiSudoAttempts?: Map<string, { count: number; until: number }> }
).__oiSudoAttempts ??= new Map());

/** Milliseconds remaining on a lockout, or 0 if the admin may try again. */
export function lockoutRemaining(adminId: string): number {
  const entry = attempts.get(adminId);
  if (!entry || entry.until <= Date.now()) return 0;
  return entry.until - Date.now();
}

export function recordFailedAttempt(adminId: string): void {
  const entry = attempts.get(adminId);
  // A lockout that has already elapsed starts the count again. Both branches of
  // this used to add 1 to the old count, so once an admin had tripped the
  // limit, every single later typo re-locked them for another five minutes,
  // for ever — during exactly the support call they were trying to answer.
  const servedLockout = !!entry && entry.until > 0 && entry.until <= Date.now();
  const count = servedLockout ? 1 : (entry?.count ?? 0) + 1;
  attempts.set(adminId, {
    count,
    until: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0,
  });
}

export function clearFailedAttempts(adminId: string): void {
  attempts.delete(adminId);
}
