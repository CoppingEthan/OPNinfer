import { createHash, randomBytes } from "node:crypto";

/**
 * Single-use token helpers for invites and password resets (spec §5).
 * The raw token goes in the emailed link; only its SHA-256 hash is stored, so
 * a database leak can't be used to accept invites or reset passwords.
 */

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
