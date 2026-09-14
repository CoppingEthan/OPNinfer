import { db } from "./db";
import type { Prisma } from "@prisma/client";

/**
 * Typed accessors for the system-wide `settings` key-value table (spec §4/§9).
 */
export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row ? (row.value as T) : null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const json = value as Prisma.InputJsonValue;
  await db.setting.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

/** Well-known setting keys. */
export const SETTING_KEYS = {
  smtp: "smtp",
  allowedProviders: "allowed_providers",
  defaultModel: "default_model",
  maxUploadBytes: "max_upload_bytes",
  branding: "branding",
  assistant: "assistant_config",
  usageVisibility: "usage_visibility",
  backup: "backup_config",
  alerts: "alerts",
  limits: "token_limits",
  weeklyReport: "weekly_report",
} as const;

/**
 * Hard ceiling for the admin-configurable per-file upload limit.
 *
 * This is NOT a free choice: our middleware matches the upload routes, and Next
 * clones a matched request's body with a cap of
 * `experimental.middlewareClientMaxBodySize` (next.config.ts) — SILENTLY
 * TRUNCATING past it. So an admin allowed to set 500 MB would get uploads that
 * pass the size gate, arrive truncated, and die in busboy as "Unexpected end of
 * form" — a 400 that reads as "the app is broken", with nothing logging the
 * real cause. It was 2 GB against a 256 MB clone cap.
 *
 * Keep this equal to that value. Raising one means raising the other (and the
 * reverse proxy's body limit), which `upload-limit.test.ts` checks.
 */
export const MAX_UPLOAD_CEILING = 256 * 1024 * 1024;

/**
 * Per-file upload limit in bytes: the admin setting when present, else the
 * `OPNINFER_MAX_UPLOAD_BYTES` env default (50 MB).
 */
export async function getMaxUploadBytes(): Promise<number> {
  const stored = await getSetting<number>(SETTING_KEYS.maxUploadBytes);
  const fallback = Number(process.env.OPNINFER_MAX_UPLOAD_BYTES ?? 52_428_800);
  const value = typeof stored === "number" && stored > 0 ? stored : fallback;
  return Math.min(value, MAX_UPLOAD_CEILING);
}
