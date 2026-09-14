import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  Credential,
  Model,
  Provider,
  TokenUsage,
} from "./types";
import { isAbortError, isRetryableError } from "./errors";

/**
 * Google Gemini via the current `@google/genai` SDK (the spec's
 * `@google/generative-ai` is deprecated). Differences from the others:
 *  - roles are `user` / `model` (not `assistant`); system prompt is a separate
 *    `systemInstruction`, not a message.
 *  - usage is `usageMetadata`; `cachedContentTokenCount` is a SUBSET of
 *    `promptTokenCount` (like OpenAI), so subtract it for full-price input.
 *  - thinking tokens (`thoughtsTokenCount`) are billed as output.
 */

const FALLBACK_MODELS: Model[] = [
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (preview)" },
  { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (preview)" },
];

function client(creds: Credential): GoogleGenAI {
  return new GoogleGenAI({ apiKey: creds.secret });
}

function stripPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

/** Word levels → Gemini's ThinkingLevel enum (Gemini 3.x preferred control). */
const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Map the admin's reasoning value to Gemini's thinkingConfig. Gemini 3.x uses
 * `thinkingLevel` (minimal/low/medium/high) — the preferred control; the older
 * `thinkingBudget` token count still works on 2.5 and for explicit off/dynamic
 * (`0` disables where allowed, `-1` is dynamic). A request must not set both
 * level and budget, so we pick exactly one. `includeThoughts` surfaces the live
 * thought summary whenever thinking is on.
 */
function thinkingConfig(
  reasoning?: string,
):
  | { thinkingBudget?: number; thinkingLevel?: ThinkingLevel; includeThoughts?: boolean }
  | undefined {
  const r = reasoning?.trim().toLowerCase();
  if (!r) return undefined; // model default
  if (["off", "none", "disabled", "no", "0"].includes(r)) {
    return { thinkingBudget: 0 };
  }
  if (["dynamic", "auto", "-1"].includes(r)) {
    return { thinkingBudget: -1, includeThoughts: true };
  }
  const level = THINKING_LEVELS[r];
  if (level) {
    return { thinkingLevel: level, includeThoughts: true };
  }
  const n = Number(r);
  if (Number.isFinite(n)) {
    return { thinkingBudget: Math.trunc(n), includeThoughts: true };
  }
  return { includeThoughts: true }; // unknown → default depth, surface thoughts
}

function mapUsage(meta: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}): TokenUsage {
  const prompt = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0, // Gemini explicit caches are billed/created separately.
  };
}

/**
 * Map neutral ChatMessages into Gemini `contents`.
 *
 * Exported for tests: this mapping holds two trapdoors that each broke every
 * tool-using turn on this provider in production — the `thoughtSignature` that
 * Gemini 3 requires echoed back on replay, and empty turns, which the API
 * rejects outright. Both are unit-tested in google.test.ts rather than left to
 * a harness that needs live keys.
 */
export function toGoogleContents(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  // Gemini shape: assistant → `model` with functionCall parts; tool results →
  // `user` with functionResponse parts (matched by NAME, not id); user images
  // → inlineData parts ahead of the text.
  return messages
    .filter((m) => m.role !== "system")
    .flatMap((m) => {
      if (m.role === "tool") {
        return [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: m.toolName ?? "tool",
                  response: { result: m.content },
                },
              },
            ],
          },
        ];
      }
      const parts: Record<string, unknown>[] = [];
      if (m.role === "user" && m.images?.length) {
        for (const img of m.images) {
          parts.push({
            inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
          });
        }
      }
      if (m.content) parts.push({ text: m.content });
      if (m.role === "assistant" && m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            /* malformed args — send empty */
          }
          parts.push({
            functionCall: { name: tc.name, args },
            ...(tc.signature ? { thoughtSignature: tc.signature } : {}),
          });
        }
      }
      // A turn with nothing in it — a reply that was only a visualisation or
      // a generated image, or one stopped right after a tool call — must be
      // DROPPED, not sent as an empty text part. Gemini rejects the empty
      // part, and because a 4xx is (correctly) never failed over, replaying
      // one would break that conversation permanently.
      if (parts.length === 0) return [];
      return [{ role: m.role === "assistant" ? "model" : "user", parts }];
    });
}

export const googleProvider: Provider = {
  id: "google",

  async listModels(creds: Credential): Promise<Model[]> {
    const ai = client(creds);
    const models: Model[] = [];
    // Pager auto-paginates. Keep only models that support generateContent.
    for await (const m of await ai.models.list()) {
      const actions = (m.supportedActions ?? []) as string[];
      if (actions.length && !actions.includes("generateContent")) continue;
      if (!m.name) continue;
      models.push({
        id: stripPrefix(m.name),
        displayName: m.displayName ?? stripPrefix(m.name),
        contextWindow: m.inputTokenLimit,
        maxOutputTokens: m.outputTokenLimit,
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  },

  async *streamChat(
    req: ChatRequest,
    creds: Credential,
  ): AsyncIterable<ChatChunk> {
    const ai = client(creds);
    // Declared outside the try so the catch can still bill what was counted.
    let lastUsage: TokenUsage | null = null;

    const systemInstruction = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const contents = toGoogleContents(req.messages);

    try {
      const thinking = thinkingConfig(req.reasoning);
      const stream = await ai.models.generateContentStream({
        model: req.model,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          ...(thinking ? { thinkingConfig: thinking } : {}),
          ...(req.tools && req.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: req.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters as unknown as Schema,
                    })),
                  },
                ],
              }
            : {}),
          abortSignal: req.signal,
        },
      });

      // usageMetadata accrues across chunks; the final chunk carries the
      // cumulative totals. Keep the last one seen and emit it at the end.
      // Parts flagged `thought` are reasoning summaries (includeThoughts);
      // everything else is the answer.
      lastUsage = null;
      // Gemini gives a function call no id of its own. Using the tool NAME as
      // the id collides the moment it batches two calls to the same tool in one
      // round ("read both files"), because every downstream consumer — the run
      // tracker, the run_start/run_done events, the route's toolRuns map — is
      // keyed by id: the two merge into one block and the second overwrites the
      // first's chips. A per-turn counter keeps them distinct. Safe because the
      // functionResponse is matched back by NAME, not by id.
      let callSeq = 0;
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.functionCall) {
            const argsJson = JSON.stringify(part.functionCall.args ?? {});
            const callId = `${part.functionCall.name ?? "call"}#${callSeq++}`;
            // Gemini delivers the call whole, not incrementally — emit the
            // args as ONE delta so the code-preview UI still fills (at once).
            yield {
              type: "tool_call_delta",
              callId,
              name: part.functionCall.name ?? "",
              argsDelta: argsJson,
            };
            yield {
              type: "tool_call",
              id: callId,
              name: part.functionCall.name ?? "",
              arguments: argsJson,
              // Gemini 3 requires this echoed back on replay (400 without it).
              signature: (part as { thoughtSignature?: string })
                .thoughtSignature,
            };
            continue;
          }
          if (!part.text) continue;
          if (part.thought) yield { type: "thinking", delta: part.text };
          else yield { type: "text", delta: part.text };
        }
        if (chunk.usageMetadata) lastUsage = mapUsage(chunk.usageMetadata);
      }
      if (lastUsage) yield { type: "usage", usage: lastUsage };
    } catch (error) {
      // Whatever was counted before the break is still billed (audit
      // 2026-09-05): a Stop or a mid-stream error used to record $0.
      if (lastUsage) yield { type: "usage", usage: lastUsage };
      // Client disconnect — not a failure; must not fail over (see errors.ts).
      if (isAbortError(error, req.signal)) return;
      yield {
        type: "error",
        message:
          error instanceof Error ? error.message : "Google request failed.",
        retryable: isRetryableError(error),
      };
    }
  },

  fallbackModels: () => FALLBACK_MODELS,
};
