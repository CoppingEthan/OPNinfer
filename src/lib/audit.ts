import { db } from "./db";
import type { Prisma } from "@prisma/client";

/** Append an entry to the audit log (spec §9 — admin actions are logged). */
export async function audit(
  action: string,
  opts: { userId?: string | null; details?: Prisma.InputJsonValue } = {},
): Promise<void> {
  await db.auditLog.create({
    data: {
      action,
      userId: opts.userId ?? null,
      details: opts.details,
    },
  });
}
