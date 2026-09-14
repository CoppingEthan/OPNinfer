/**
 * Provider abstraction layer (spec §3). One internal interface for every model
 * provider; each implementation lives in `lib/providers/<id>.ts`, so adding a
 * provider is a single new file.
 */

export type ProviderId = "openai" | "anthropic-api" | "google";

/** A decrypted credential, ready to authenticate an upstream request. */
export interface Credential {
  /** DB id of the `provider_credentials` row (cache key, last-used updates). */
  id: string;
  provider: ProviderId;
  /** Decrypted API key. */
  secret: string;
  metadata?: Record<string, unknown>;
}

/** A model exposed by a provider's list endpoint (or the fallback baseline). */
export interface Model {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** An image attached to a user turn — sent to vision-capable models natively. */
export interface ImagePart {
  mimeType: string;
  dataBase64: string;
}

/** One tool invocation made by an assistant turn (replayed in the tool loop). */
export interface ToolCallPart {
  id: string;
  name: string;
  /** Raw JSON string of the arguments. */
  arguments: string;
  /** Gemini 3 `thoughtSignature` — must be echoed back on replay or the API
   *  rejects the request. Opaque; other providers ignore it. */
  signature?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Native-vision images on a `user` turn. Each provider maps its own shape. */
  images?: ImagePart[];
  /** Tool calls this `assistant` turn made (the loop echoes them back). */
  toolCalls?: ToolCallPart[];
  /** `tool` role: id of the call this result answers (OpenAI/Anthropic). */
  toolCallId?: string;
  /** `tool` role: the tool's name (Google matches results by name). */
  toolName?: string;
}

/** A tool the model may call (v0.2: used for escalation hand-off). */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Tools the model may call. Each provider maps these to its own format. */
  tools?: ToolDef[];
  /**
   * Admin-configured, provider-native reasoning level for this model (spec §6).
   * Free text interpreted per provider: OpenAI → `reasoning_effort`; Anthropic →
   * effort level (or "off" to disable thinking); Google → `thinkingBudget`
   * (a token count, `-1` for dynamic, `0` for off). Empty/undefined = provider
   * default. Each provider maps this in its own `streamChat`.
   */
  reasoning?: string;
  /** Abort the upstream request (client disconnects, stop button). */
  signal?: AbortSignal;
}

/**
 * Normalized token usage across providers. Each provider reports cache tokens
 * differently (OpenAI/Google fold cached tokens into the prompt total; Anthropic
 * reports them separately and also charges a cache-WRITE tier) — every provider
 * implementation maps its raw usage into this single shape so cost is computed
 * one way. Invariant: `inputTokens` is the FULL-PRICE (uncached) input only, so
 *   total prompt tokens = inputTokens + cacheReadTokens + cacheWriteTokens.
 */
export interface TokenUsage {
  /** Uncached input tokens, billed at the full input rate. */
  inputTokens: number;
  outputTokens: number;
  /** Cached input served at the discounted cache-read rate. */
  cacheReadTokens: number;
  /** Cache-write tokens (Anthropic only; 0 elsewhere), billed at a premium. */
  cacheWriteTokens: number;
}

/** Streaming output. The server proxies `text` deltas to the browser as SSE
 *  and, on `usage`, writes a `usage_records` row (spec §6). */
export type ChatChunk =
  | { type: "text"; delta: string }
  /** Summarized reasoning shown live (Anthropic/Google); never persisted. */
  | { type: "thinking"; delta: string }
  /** The model asked to call a tool. `arguments` is a raw JSON string.
   *  `signature` is Gemini 3's thoughtSignature (echoed back on replay). */
  | { type: "tool_call"; id: string; name: string; arguments: string; signature?: string }
  /** Partial tool-call arguments AS the model writes them (OpenAI/Anthropic
   *  stream these token by token; Google emits one whole-args burst). Powers
   *  the live code-preview UI only — the authoritative call is the
   *  `tool_call` chunk that follows. Consumers may ignore these. */
  | { type: "tool_call_delta"; callId: string; name: string; argsDelta: string }
  | { type: "usage"; usage: TokenUsage }
  /** `retryable: false` marks a client/config error (4xx) that should surface
   *  to the admin rather than trigger failover. Omitted/true = transient. */
  | { type: "error"; message: string; retryable?: boolean };

export interface Provider {
  readonly id: ProviderId;
  /** Live model discovery (spec §6). Throws on failure; callers fall back. */
  listModels(creds: Credential): Promise<Model[]>;
  streamChat(req: ChatRequest, creds: Credential): AsyncIterable<ChatChunk>;
  /** Hardcoded baseline used when `listModels` fails (spec §6). */
  fallbackModels(): Model[];
}
