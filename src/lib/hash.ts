import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing with argon2id (spec §5 — argon2id, never bcrypt).
 *
 * We use `@node-rs/argon2` (prebuilt Rust binaries) rather than the `argon2`
 * npm package: same algorithm, but no node-gyp native build — far more
 * reliable on Windows dev + Node 24, which the spec flags as a pain point.
 *
 * OWASP-aligned parameters (19 MiB, 2 iterations, parallelism 1).
 */
const OPTIONS = {
  // 2 = Argon2id. Referenced numerically because @node-rs/argon2's `Algorithm`
  // is a const enum, which `isolatedModules` forbids importing as a value.
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    // Malformed hash or mismatch — treat as a failed verification.
    return false;
  }
}
