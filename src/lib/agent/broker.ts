import "server-only";
import { devLog } from "@/lib/dev-log";

/**
 * Small GET client for sandboxd's read endpoints (`/packages`,
 * `/agent-mcp`). One place for the URL and the bearer, because the first
 * reader (packages-store) used a `SANDBOX_URL` variable that nothing sets —
 * fine in dev, where the broker publishes on localhost, and always
 * "unavailable" in production, where the app must reach `http://sandboxd:8070`
 * through SANDBOX_BROKER_URL like every other broker call.
 */

export function brokerConfigured(): boolean {
  return !!process.env.SANDBOX_BROKER_URL && !!process.env.SANDBOX_BROKER_TOKEN;
}

export async function brokerGet<T>(path: string, opts: { timeoutMs?: number } = {}): Promise<T | null> {
  const token = process.env.SANDBOX_BROKER_TOKEN;
  if (!token) return null;
  const base = (process.env.SANDBOX_BROKER_URL ?? "http://localhost:8070").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      cache: "no-store",
    });
    if (!res.ok) {
      devLog("warn", "agent", `broker GET ${path} → ${res.status}`, { body: (await res.text()).slice(0, 300) });
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    devLog("warn", "agent", `broker GET ${path} failed`, { error: String(e) });
    return null;
  }
}
