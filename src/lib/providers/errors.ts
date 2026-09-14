/**
 * Whether a provider error is worth failing over for. Transient problems
 * (network blips, 5xx, rate limits, timeouts) are retryable → trigger the
 * failover model. Client errors (4xx: bad request, auth, model-not-found) are
 * configuration bugs that should surface to the admin, not be masked by a
 * silent switch to another provider.
 */
export function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") {
    // No HTTP status: retryable only when it LOOKS like the network (the SDKs'
    // connection errors, Node's socket codes, undici's "fetch failed"). Any
    // other exception is one of OUR bugs — a decrypt failure after a
    // master-key mismatch, a Prisma write in the tool loop — and failing over
    // would mask it as a WARN and suppress the alert (audit 2026-09-05).
    const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } } | null | undefined;
    const name = e?.name ?? "";
    const code = e?.code ?? e?.cause?.code ?? "";
    const msg = e?.message ?? "";
    if (/^APIConnection(Timeout)?Error$/.test(name)) return true;
    if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR)/.test(code)) return true;
    if (/fetch failed|socket hang up|network|timed? ?out/i.test(msg)) return true;
    return false;
  }
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/**
 * Whether an error is a caller-initiated abort (the client disconnected or
 * navigated away mid-stream). An abort is NOT a failure and must never fail
 * over — the user is already gone; a failover call just burns a second model
 * and logs a spurious "conversation model failed" WARN.
 *
 * Provider SDKs surface aborts inconsistently. The Stainless SDKs (OpenAI and
 * Anthropic) throw an `APIUserAbortError` whose `.name` is the inherited
 * "Error" — NOT "AbortError" — and whose `.status` is undefined, so a
 * name-only check misses it and `isRetryableError` then treats it as transient.
 * The `AbortSignal` is the source of truth: if it's aborted when we land in the
 * catch, the turn was aborted regardless of how the SDK named the error.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const ctor = (error as { constructor?: { name?: string } } | null | undefined)
    ?.constructor?.name;
  return ctor === "APIUserAbortError";
}
