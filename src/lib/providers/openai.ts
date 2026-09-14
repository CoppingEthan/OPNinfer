import { appLog } from "@/lib/applog";
import OpenAI from "openai";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  Credential,
  Model,
  Provider,
} from "./types";
import { isAbortError, isRetryableError } from "./errors";

function client(creds: Credential): OpenAI {
  // Optional endpoint override (OpenAI-compatible self-hosted servers; also
  // the failover test rig's deterministic network-error lever).
  const baseUrl = typeof creds.metadata?.baseUrl === "string" ? creds.metadata.baseUrl : undefined;
  return new OpenAI({ apiKey: creds.secret, ...(baseUrl ? { baseURL: baseUrl } : {}) });
}

/**
 * Map the neutral message shape to Chat Completions params: tool results use
 * the `tool` role + `tool_call_id`; an assistant turn that called tools echoes
 * them under `tool_calls`; user images become `image_url` data-URI parts.
 */
function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.ChatCompletionMessageParam => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          ...m.images.map((img) => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
          })),
          { type: "text" as const, text: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Heuristic for chat-capable models. OpenAI's list endpoint doesn't return
 * capabilities, so we keep GPT / o-series chat models and drop non-chat
 * families (embeddings, audio, image, moderation, …).
 */
const CHAT_PREFIXES = ["gpt-", "chatgpt", "o1", "o3", "o4"];
const NON_CHAT_MARKERS = [
  "embedding",
  "whisper",
  "tts",
  "audio",
  "realtime",
  "image",
  "dall-e",
  "moderation",
  "instruct",
  "transcribe",
  "search",
];

export function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (NON_CHAT_MARKERS.some((m) => lower.includes(m))) return false;
  return CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

function humanize(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Gpt/g, "GPT");
}

export const openaiProvider: Provider = {
  id: "openai",

  async listModels(creds: Credential): Promise<Model[]> {
    const list = await client(creds).models.list();
    return list.data
      .filter((m) => isChatModel(m.id))
      .map((m) => ({ id: m.id, displayName: humanize(m.id) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async *streamChat(
    req: ChatRequest,
    creds: Credential,
  ): AsyncIterable<ChatChunk> {
    try {
      const reasoning = req.reasoning?.trim();
      const stream = await client(creds).chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.messages),
          // `max_completion_tokens` is the current parameter; the legacy
          // `max_tokens` is rejected with a 400 by gpt-5.x / o-series models.
          max_completion_tokens: req.maxTokens,
          // Admin-set reasoning effort, passed straight through. Values vary by
          // model (minimal/none·low·medium·high·xhigh); non-reasoning models
          // (gpt-4.x) reject it, so only send it when configured. Chat
          // Completions does not stream the reasoning text, so OpenAI has no
          // live "thinking" panel (would require the Responses API).
          ...(reasoning
            ? { reasoning_effort: reasoning as "low" | "medium" | "high" }
            : {}),
          ...(req.tools && req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  type: "function" as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );

      // Tool-call deltas arrive piecemeal, keyed by index; accumulate and emit
      // once the model signals it's done calling tools.
      const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
      let toolCallsEmitted = false;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) yield { type: "text", delta: delta.content };

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const cur = (toolCalls[tc.index] ??= { id: "", name: "", args: "" });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) {
              cur.args += tc.function.arguments;
              // Live partial args for the code-preview UI (id + name arrive in
              // the call's first delta, so later fragments are attributable).
              if (cur.id && cur.name) {
                yield { type: "tool_call_delta", callId: cur.id, name: cur.name, argsDelta: tc.function.arguments };
              }
            }
          }
        }
        if (choice?.finish_reason === "tool_calls") {
          for (const tc of Object.values(toolCalls)) {
            yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.args || "{}" };
          }
          toolCallsEmitted = true;
        } else if (choice?.finish_reason === "length") {
          // A truncated reply is a perfectly successful API call — the only
          // symptom is output pinned at the ceiling. Say so where an admin
          // looks (CLAUDE.md: the 4096 incident).
          void appLog("warn", "chat", "Reply cut off at the output limit.", {
            details: { provider: "openai", model: req.model, finishReason: "length" },
          }).catch(() => {});
        }

        // With include_usage, the final (choices-empty) chunk carries totals.
        // OpenAI's `prompt_tokens` INCLUDES cached tokens, so subtract the
        // cached portion to get the full-price input (normalized convention).
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens - cached,
              outputTokens: chunk.usage.completion_tokens,
              cacheReadTokens: cached,
              cacheWriteTokens: 0, // OpenAI caching is automatic; no write tier.
            },
          };
        }
      }
      // Accumulated calls the model never closed with finish_reason
      // "tool_calls" (a "length" stop mid-arguments, or an OpenAI-compatible
      // endpoint that says "stop") were silently dropped — the loop then told
      // the user it couldn't do the work (audit 2026-09-05). Emit what we have.
      if (!toolCallsEmitted) {
        for (const tc of Object.values(toolCalls)) {
          if (tc.id && tc.name) yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.args || "{}" };
        }
      }
    } catch (error) {
      // Abort is expected on client disconnect — don't surface as an error or
      // fail over (the SDK's APIUserAbortError is named "Error" — see errors.ts).
      if (isAbortError(error, req.signal)) return;
      yield {
        type: "error",
        message:
          error instanceof Error ? error.message : "OpenAI request failed.",
        retryable: isRetryableError(error),
      };
    }
  },

  fallbackModels(): Model[] {
    // Baseline used only if the live list fails (spec §6). Current chat models
    // verified against a live account (June 2026).
    return [
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "gpt-5.4", displayName: "GPT-5.4" },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
      { id: "gpt-5.4-nano", displayName: "GPT-5.4 nano" },
      { id: "gpt-4.1", displayName: "GPT-4.1" },
    ];
  },
};
