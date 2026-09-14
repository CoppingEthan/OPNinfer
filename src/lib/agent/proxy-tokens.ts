/**
 * Per-chat bearer tokens for the credential proxy — the API-key path's whole
 * security model, so it is pure and tested.
 *
 * On the org-API-key path the agent container must never see the key: a
 * container that runs model-written code can read its own environment. So
 * the CLI is pointed at OPNinfer's proxy with a short-lived token that
 * identifies ONE run of ONE chat, and the proxy swaps in the real key
 * server-side. The token is also the metering and budget handle: every
 * proxied call charges it, and a spent token is refused.
 *
 * In-memory, anchored on globalThis like the turn registry — a token lives
 * for one run and dies with the process, which is the right lifetime.
 */

export interface ProxyGrant {
  token: string;
  conversationId: string;
  userId: string;
  /** provider_credentials row the proxy injects. */
  credentialId: string;
  /** Model calls stop being forwarded once spend reaches this (USD). */
  ceilingUsd: number;
  spentUsd: number;
  calls: number;
  expiresAt: number;
  revoked: boolean;
}

const grants: Map<string, ProxyGrant> = ((
  globalThis as { __oiProxyGrants?: Map<string, ProxyGrant> }
).__oiProxyGrants ??= new Map());

/** Default lifetime — comfortably past any run budget; the run revokes it
 *  on the way out anyway. */
export const PROXY_TOKEN_TTL_MS = 2 * 60 * 60_000;

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function mintProxyToken(
  opts: {
    conversationId: string;
    userId: string;
    credentialId: string;
    ceilingUsd: number;
    ttlMs?: number;
  },
  now: number = Date.now(),
): ProxyGrant {
  pruneProxyTokens(now); // as documented below — a run whose finally never ran must not leak forever
  const grant: ProxyGrant = {
    token: randomToken(),
    conversationId: opts.conversationId,
    userId: opts.userId,
    credentialId: opts.credentialId,
    ceilingUsd: Math.max(0, opts.ceilingUsd),
    spentUsd: 0,
    calls: 0,
    expiresAt: now + (opts.ttlMs ?? PROXY_TOKEN_TTL_MS),
    revoked: false,
  };
  grants.set(grant.token, grant);
  return grant;
}

/** The live grant for a token, or null if unknown / expired / revoked. */
export function lookupProxyToken(token: string, now: number = Date.now()): ProxyGrant | null {
  const g = grants.get(token);
  if (!g || g.revoked) return null;
  if (g.expiresAt <= now) {
    grants.delete(token);
    return null;
  }
  return g;
}

/** Is this grant allowed to make another call? A ceiling of 0 means "no
 *  ceiling" (subscription-style trust); otherwise spend must be under it. */
export function proxyCallAllowed(g: ProxyGrant): boolean {
  return g.ceilingUsd === 0 || g.spentUsd < g.ceilingUsd;
}

/** Book a completed call's cost against the grant. */
export function chargeProxyToken(token: string, usd: number): ProxyGrant | null {
  const g = grants.get(token);
  if (!g) return null;
  g.spentUsd += Math.max(0, usd);
  g.calls += 1;
  return g;
}

export function revokeProxyToken(token: string): void {
  const g = grants.get(token);
  if (g) g.revoked = true;
  grants.delete(token);
}

/** Housekeeping — drop expired grants (called opportunistically by mint). */
export function pruneProxyTokens(now: number = Date.now()): number {
  let n = 0;
  for (const [t, g] of grants) {
    if (g.expiresAt <= now || g.revoked) {
      grants.delete(t);
      n++;
    }
  }
  return n;
}

/** Test seam. */
export function resetProxyTokens(): void {
  grants.clear();
}
