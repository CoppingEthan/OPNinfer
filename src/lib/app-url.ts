/** Absolute URL for a path, based on AUTH_URL (used in emailed links). */
export function appUrl(path = "/"): string {
  const base = process.env.AUTH_URL ?? "http://localhost:3000";
  return new URL(path, base).toString();
}
