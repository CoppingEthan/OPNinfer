import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. Next.js dev hot-reloads modules, which would
 * otherwise spawn a new pool of connections on every reload — cache the client
 * on `globalThis` to reuse one instance.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
