import { appLog } from "@/lib/applog";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatChunk,
  ChatRequest,
  Credential,
  Model,
  Provider,
  ProviderId,
} from "./types";
import { isAbortError, isRetryableError } from "./errors";

/**
 * Anthropic via the Console API key (`x-api-key` header), pay-as-you-go at
 * standard token rates. Subscription OAuth was removed — Anthropic prohibits
 * routing third-party users through Pro/Max credentials; a Console API key is
 * the supported path.
 */

// Fallback ceiling when the caller doesn't pass one. The instance-wide limit
// (Admin → Models, `src/lib/limits.ts`, 64k by default) normally supplies it.
//
// This used to be 4096 for non-thinking requests, on the assumption that
// omitting `thinking` meant the model wasn't thinking. That assumption broke
// on Claude Sonnet 5, which runs adaptive thinking BY DEFAULT when `thinking`
// is omitted — so thinking silently ate a 4096-token budget and every
// substantive turn was truncated mid-tool-call. It cost a real user four
// rounds of asking for a file that could never arrive, and logged nothing,
// because a truncated response is a successful API call. Never infer "not
// thinking" from an omitted parameter again.
const DEFAULT_MAX_TOKENS = 64000;

const FALLBACK_MODELS: Model[] = [
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
];

function apiKeyClient(creds: Credential): Anthropic {
  return new Anthropic({ apiKey: creds.secret });
}

// --- Messages-API core -------------------------------------------------------

/**
 * Split our flat message list into Anthropic's `system` + `messages` shape and
 * place prompt-cache breakpoints. Anthropic only caches when `cache_control` is
 * set, so we mark the system prompt and the final message — that caches the
 * stable conversation prefix, which is read back (at 0.1× input) on later turns
 * once it exceeds the model's minimum cacheable size. Cache tokens are then
 * reported in `cache_read/creation_input_tokens` and tracked exactly.
 *
 * Exported for tests. Three of the rules in here were each written after a live
 * failure — tool_result blocks must sit at the FRONT of a merged user turn, a
 * turn with no content must be dropped rather than sent as an empty text block,
 * and consecutive user turns must be merged to keep roles alternating — and
 * until now the only thing checking them was a harness that needs live keys.
 */
export function toAnthropicMessages(req: ChatRequest): {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemText = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  // Build content-block messages. Tool results become `tool_result` blocks in
  // a USER turn (consecutive results merge into one — required for parallel
  // calls); an assistant turn that called tools carries `tool_use` blocks;
  // user images become base64 `image` blocks ahead of the text.
  const nonSystem = req.messages.filter((m) => m.role !== "system");
  const messages: Anthropic.MessageParam[] = [];
  for (const m of nonSystem) {
    if (m.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }

    const role = m.role as "user" | "assistant";
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.role === "user" && m.images?.length) {
      for (const img of m.images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType as "image/png",
            data: img.dataBase64,
          },
        });
      }
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments || "{}");
        } catch {
          /* malformed args from a retry — send empty input */
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
    }
    // An assistant turn can legitimately carry no text: a reply that was only
    // a visualisation or a generated image, or one stopped right after a tool
    // call. Anthropic rejects an empty text block, so replaying one 400s — and
    // a 4xx is (correctly) never failed over, which means the conversation
    // could never accept another message again. Drop the turn instead.
    if (blocks.length === 0) {
      if (!m.content) continue;
      blocks.push({ type: "text", text: m.content });
    }

    // Anthropic requires strictly alternating roles: merge consecutive USER
    // turns (e.g. tool_result blocks followed by a tool-attached image turn)
    // into one message.
    const prev = messages[messages.length - 1];
    if (role === "user" && prev && prev.role === "user" && Array.isArray(prev.content)) {
      (prev.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  // Anthropic requires every tool_result for a preceding tool_use turn to sit
  // contiguously ahead of any other content in the following user message. A
  // tool result carrying images (view_image) merges its caption+image blocks
  // into the same turn as a later tool's result (multiple tools called in one
  // round) — stable-sort tool_result blocks back to the front so a later
  // tool_result is never left stranded behind non-tool_result content.
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const results = msg.content.filter((b) => b.type === "tool_result");
      const rest = msg.content.filter((b) => b.type !== "tool_result");
      if (results.length > 0 && rest.length > 0) {
        msg.content = [...results, ...rest];
      }
    }
  }

  // Prompt-cache breakpoint on the final block of the final message: caches
  // the stable conversation prefix for cheap re-reads on later turns.
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1];
    (lastBlock as { cache_control?: { type: "ephemeral" } }).cache_control = {
      type: "ephemeral",
    };
  }

  const system: Anthropic.TextBlockParam[] | undefined = systemText
    ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
    : undefined;

  return { system, messages };
}

async function listModels(client: Anthropic): Promise<Model[]> {
  const models: Model[] = [];
  // models.list() auto-paginates. Anthropic returns context-window / output
  // limits (max_input_tokens / max_tokens) on each model since Mar 2026.
  for await (const m of client.models.list()) {
    const meta = m as typeof m & {
      max_input_tokens?: number;
      max_tokens?: number;
    };
    models.push({
      id: m.id,
      displayName: m.display_name ?? m.id,
      contextWindow: meta.max_input_tokens,
      maxOutputTokens: meta.max_tokens,
    });
  }
  return models.sort((a, b) => b.id.localeCompare(a.id));
}

/** Effort levels accepted by Claude 4.x via `output_config.effort`
 *  (low/medium/high/xhigh/max; default high). */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_OFF = new Set(["off", "none", "disabled", "no"]);

/**
 * Map the admin's free-text reasoning value to Anthropic's thinking + effort
 * params. `budget_tokens` is rejected on Opus 4.7/4.8 — adaptive thinking is the
 * only on-mode, with depth controlled by `output_config.effort`. `display:
 * "summarized"` makes thinking stream to the client.
 */
function reasoningParams(reasoning?: string): Record<string, unknown> {
  const r = reasoning?.trim().toLowerCase();
  if (!r || THINKING_OFF.has(r)) return {}; // omit thinking → standard mode
  const thinking = { type: "adaptive", display: "summarized" };
  if (EFFORT_LEVELS.has(r)) {
    return { thinking, output_config: { effort: r } };
  }
  // "adaptive" or anything else → adaptive thinking at the model default effort.
  return { thinking };
}

async function* streamChat(
  client: Anthropic,
  req: ChatRequest,
): AsyncIterable<ChatChunk> {
  // Running usage, declared OUTSIDE the try so the catch can bill what was
  // counted before a break (audit 2026-09-05). `as`: keeps TS from narrowing
  // it to `null` inside the loop.
  type RunningUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  let partial = null as RunningUsage | null;
  const { system, messages } = toAnthropicMessages(req);

  const reasoning = reasoningParams(req.reasoning);
  // One ceiling regardless of reasoning setting. Thinking counts against
  // max_tokens, and current models may think whether or not we ask them to, so
  // the budget can't be conditional on what we think we configured.
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;

  try {
    // NOTE: we deliberately do NOT forward `temperature` — current Opus models
    // (4.7/4.8) reject sampling params with a 400. max_tokens is required.
    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools && req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
                // Fine-grained tool streaming (GA, no beta header): without
                // this Anthropic BUFFERS input_json_delta events and delivers
                // the args in one late burst — which defeated the live
                // "watching it type" code preview (found in owner testing).
                eager_input_streaming: true,
              })),
            }
          : {}),
        ...reasoning,
      } as Anthropic.MessageStreamParams,
      { signal: req.signal },
    );

    // A tool_use block streams as start (id/name) → input_json_delta… → stop.
    let toolUse: { id: string; name: string; args: string } | null = null;
    // Running usage (audit 2026-09-05): message_start carries the input
    // tiers, message_delta the cumulative output. If the stream breaks — a
    // Stop, the hard stop, a 529 mid-reply — Anthropic has billed all of it,
    // and this is what lets the ledger say so instead of $0.
    for await (const event of stream) {
      if (event.type === "message_start") {
        const u = event.message.usage;
        partial = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        };
      } else if (event.type === "message_delta" && partial && event.usage) {
        partial = { ...partial, outputTokens: event.usage.output_tokens ?? partial.outputTokens };
      }
      if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        toolUse = { id: event.content_block.id, name: event.content_block.name, args: "" };
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking", delta: event.delta.thinking };
        } else if (event.delta.type === "input_json_delta" && toolUse) {
          toolUse.args += event.delta.partial_json;
          // Live partial args for the code-preview UI.
          yield { type: "tool_call_delta", callId: toolUse.id, name: toolUse.name, argsDelta: event.delta.partial_json };
        }
      } else if (event.type === "content_block_stop" && toolUse) {
        yield { type: "tool_call", id: toolUse.id, name: toolUse.name, arguments: toolUse.args || "{}" };
        toolUse = null;
      }
    }

    // Anthropic's `input_tokens` is the UNCACHED remainder; cache reads and
    // (uniquely) cache writes are reported separately — map straight across.
    const final = await stream.finalMessage();
    partial = null; // the final figures supersede the running ones
    if (final.stop_reason === "max_tokens") {
      // A truncated reply is a perfectly successful API call; the only
      // symptom is output pinned at the ceiling (CLAUDE.md: the 4096
      // incident). Say so where an admin looks.
      void appLog("warn", "chat", "Reply cut off at the output limit.", {
        details: { provider: "anthropic", model: req.model, maxTokens, outputTokens: final.usage.output_tokens },
      }).catch(() => {});
    }
    yield {
      type: "usage",
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (error) {
    // Whatever was counted before the break is still billed — record it.
    if (partial) yield { type: "usage", usage: partial };
    // Client disconnect — not a failure; must not fail over (the SDK's
    // APIUserAbortError is named "Error", so trust the signal — see errors.ts).
    if (isAbortError(error, req.signal)) return;
    yield {
      type: "error",
      message:
        error instanceof Error ? error.message : "Anthropic request failed.",
      retryable: isRetryableError(error),
    };
  }
}

function makeAnthropicProvider(
  id: ProviderId,
  clientFor: (creds: Credential) => Anthropic,
): Provider {
  return {
    id,
    listModels: (creds) => listModels(clientFor(creds)),
    streamChat: (req, creds) => streamChat(clientFor(creds), req),
    fallbackModels: () => FALLBACK_MODELS,
  };
}

/** Console API key path. */
export const anthropicApiProvider = makeAnthropicProvider(
  "anthropic-api",
  apiKeyClient,
);
