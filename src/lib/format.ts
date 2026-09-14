/**
 * Locale-independent date formatting. `toLocaleDateString()` renders in the
 * runtime's locale, which differs between the server (SSR) and the browser,
 * causing React hydration mismatches in client components. These helpers produce
 * the same string everywhere.
 */

/** ISO calendar date, e.g. "2026-06-28" (UTC). */
export function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** ISO date + minute, e.g. "2026-06-28 14:05" (UTC). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

/** Human-readable byte size, e.g. "1.4 MB". Locale-independent. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
