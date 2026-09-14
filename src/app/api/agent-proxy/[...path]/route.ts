import { loadCredential } from "@/lib/providers/credentials";
import { estimateCost } from "@/lib/providers/pricing";
import { recordUsage } from "@/lib/pipeline";
import { devLog } from "@/lib/dev-log";
import {
  chargeProxyToken,
  lookupProxyToken,
  proxyCallAllowed,
} from "@/lib/agent/proxy-tokens";
import {
  SseUsageTracker,
  isStreamingRequest,
  modelFromRequestBody,
  usageFromJsonBody,
} from "@/lib/agent/proxy-usage";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * The credential proxy — the org-API-key path for the Sandbox agent.
 *
 * The agent container is pointed here (`ANTHROPIC_BASE_URL`) with a
 * per-chat bearer token instead of a key. This route validates the token,
 * swaps in the organisation's real Anthropic key, forwards the call, streams
 * the answer back, and — the part that makes this worth a whole route —
 * reads the REAL token usage off Anthropic's response and books it against
 * the chat, the user and the token's spend ceiling. Authoritative metering,
 * not the SDK's client-side estimate.
 *
 * Excluded from the middleware matcher (bearer auth, no session — the caller
 * is a container). Only the Messages API surface is forwarded.
 */

const UPSTREAM = "https://api.anthropic.com";
/** What the CLI legitimately calls. Nothing else is forwarded. */
const ALLOWED_PATHS = /^v1\/messages(\/count_tokens)?$/;
/** Request headers passed through to Anthropic; everything else is dropped
 *  (host, content-length, our own bearer, forwarded-for…). */
const FORWARD_HEADERS = ["content-type", "anthropic-version", "anthropic-beta", "accept"];

const PROXY_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Read a body up to `max` bytes; null once it exceeds that (stream aborted). */
async function readTextBounded(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * What an UNPRICED model is charged against the run's ceiling (audit
 * 2026-09-05): `estimateCost` returns 0 for a model with no rate, so a
 * request naming any such model never advanced the spend and the ceiling —
 * the proxy's only hard brake on the org key — never tripped. Opus rates,
 * the dearest we price, so an unknown model can only be OVER-counted.
 */
function conservativeCost(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return (usage.inputTokens * 5 + usage.outputTokens * 25 + usage.cacheReadTokens * 0.5 + usage.cacheWriteTokens * 6.25) / 1_000_000;
}

function errorResponse(status: number, type: string, message: string): Response {
  // Anthropic's own error shape, so the CLI reports it as an API error.
  return Response.json({ type: "error", error: { type, message } }, { status });
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const upstreamPath = (path ?? []).join("/");
  if (!ALLOWED_PATHS.test(upstreamPath)) {
    return errorResponse(404, "not_found_error", "Not a proxied endpoint.");
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const grant = token ? lookupProxyToken(token) : null;
  if (!grant) return errorResponse(401, "authentication_error", "Invalid or expired proxy token.");
  if (!proxyCallAllowed(grant)) {
    devLog("warn", "agent", "proxy: spend ceiling reached", {
      conversationId: grant.conversationId,
      spentUsd: grant.spentUsd,
      ceilingUsd: grant.ceilingUsd,
    });
    return errorResponse(
      402,
      "billing_error",
      `This run's spend ceiling ($${grant.ceilingUsd.toFixed(2)}) has been reached.`,
    );
  }

  const cred = await loadCredential(grant.credentialId);
  if (!cred || cred.provider !== "anthropic-api") {
    return errorResponse(401, "authentication_error", "The organisation's Anthropic key is missing.");
  }

  // Bounded (audit 2026-09-05): this route sits outside the middleware body
  // cap by design, and the token holder is the agent's own shell — a
  // multi-GB POST would have been buffered whole and OOM-killed the app, and
  // every live turn with it. A Messages request is kilobytes; 10 MB is generous.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > PROXY_MAX_BODY_BYTES) {
    return errorResponse(413, "invalid_request_error", "Request body too large.");
  }
  const rawBody = await readTextBounded(req, PROXY_MAX_BODY_BYTES);
  if (rawBody === null) {
    return errorResponse(413, "invalid_request_error", "Request body too large.");
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "invalid_request_error", "Request body is not JSON.");
  }
  const model = modelFromRequestBody(body);
  const streaming = isStreamingRequest(body);

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("x-api-key", cred.secret);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");

  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}/${upstreamPath}`, {
      method: "POST",
      headers,
      body: rawBody,
      signal: req.signal,
    });
  } catch (e) {
    return errorResponse(502, "api_error", `Upstream unreachable: ${e instanceof Error ? e.message : e}`);
  }

  // Booking: real usage → usage_records (role agent) + the token's spend.
  const book = async (usage: ReturnType<typeof usageFromJsonBody>) => {
    if (!usage || !model) return;
    try {
      const cost = await recordUsage({
        userId: grant.userId,
        role: "agent",
        provider: "anthropic-api",
        model,
        usage,
      });
      const hasTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
      const charged = cost > 0 || !hasTokens ? cost : conservativeCost(usage);
      if (charged !== cost) {
        devLog("warn", "agent", "proxy: unpriced model charged at the conservative rate", { model, charged });
      }
      chargeProxyToken(grant.token, charged);
      devLog("debug", "agent", "proxy: call metered", {
        conversationId: grant.conversationId,
        model,
        in: usage.inputTokens,
        out: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cost,
        ms: Date.now() - t0,
      });
    } catch (e) {
      devLog("warn", "agent", "proxy: could not record usage", { error: String(e) });
    }
  };

  const outHeaders = new Headers();
  for (const h of ["content-type", "anthropic-version", "request-id", "x-request-id"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  outHeaders.set("cache-control", "no-store");
  outHeaders.set("x-accel-buffering", "no");

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (upstream.ok && (streaming || isSse) && upstream.body) {
    // Pass the bytes through untouched; tee text into the usage tracker.
    const tracker = new SseUsageTracker();
    const decoder = new TextDecoder();
    // Booked exactly once — on a clean end (flush) OR when the caller drops
    // the connection (audit 2026-09-05): `signal: req.signal` aborts the
    // upstream the moment the client goes, and flush never runs, so a
    // 150k-token prompt closed after message_start was billed by Anthropic
    // and booked nowhere. Whatever the tracker has seen by then is charged.
    let booked = false;
    const bookOnce = () => {
      if (booked) return;
      booked = true;
      void book(tracker.usage());
    };
    req.signal.addEventListener("abort", bookOnce, { once: true });
    const tee = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tracker.feed(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        tracker.feed(decoder.decode());
        bookOnce();
      },
    });
    return new Response(upstream.body.pipeThrough(tee), { status: upstream.status, headers: outHeaders });
  }

  const text = await upstream.text();
  if (upstream.ok) {
    try {
      await book(usageFromJsonBody(JSON.parse(text)));
    } catch {
      /* not JSON — nothing to meter */
    }
  }
  return new Response(text, { status: upstream.status, headers: outHeaders });
}
