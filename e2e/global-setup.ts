import { PrismaClient } from "@prisma/client";

/**
 * Reset the database before the E2E run so the first-run setup flow is
 * deterministic. SAFETY: refuses to truncate unless running in CI or the
 * database name contains "e2e" — this prevents accidentally wiping a dev DB.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL ?? "";
  const looksLikeE2e = /e2e/i.test(url);
  if (!process.env.CI && !looksLikeE2e) {
    throw new Error(
      "Refusing to reset a non-e2e database. Point DATABASE_URL at a database " +
        'whose name contains "e2e" (e.g. opninfer_e2e) before running E2E tests.',
    );
  }

  const db = new PrismaClient();
  try {
    // One statement, CASCADE handles FK order; RESTART IDENTITY for a clean slate.
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE
        usage_records, messages, files, conversations,
        provider_credentials, password_reset_tokens, invites,
        audit_log, app_log, settings, users
      RESTART IDENTITY CASCADE;
    `);
  } finally {
    await db.$disconnect();
  }
}
