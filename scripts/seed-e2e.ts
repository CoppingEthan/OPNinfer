/**
 * Seed a known admin + provider credential for the HTTP/SSE end-to-end check.
 *   node --env-file=.env --import tsx scripts/seed-e2e.ts
 * Prints the credentialId. Idempotent: re-running resets the user.
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { encrypt } from "../src/lib/crypto";
import { toDbProvider } from "../src/lib/providers/mapping";
import type { ProviderId } from "../src/lib/providers/types";

const EMAIL = "e2e@opninfer.local";
const PASSWORD = "password123";

async function main() {
  await db.user.deleteMany({ where: { email: EMAIL } });
  const user = await db.user.create({
    data: {
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  // Prefer the Anthropic key (cheapest haiku); fall back to whatever is present.
  const candidates: { provider: ProviderId; key?: string }[] = [
    { provider: "anthropic-api", key: process.env.ANTHROPIC_API_KEY },
    { provider: "openai", key: process.env.OPENAI_API_KEY },
    { provider: "google", key: process.env.GOOGLE_API_KEY },
  ];
  const chosen = candidates.find((c) => c.key);
  if (!chosen?.key) throw new Error("No provider key in env to seed.");

  const cred = await db.providerCredential.create({
    data: {
      userId: user.id,
      provider: toDbProvider(chosen.provider),
      label: "e2e key",
      encryptedValue: new Uint8Array(encrypt(chosen.key)),
    },
  });

  console.log(
    JSON.stringify({
      userId: user.id,
      email: EMAIL,
      password: PASSWORD,
      provider: chosen.provider,
      credentialId: cred.id,
    }),
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
