import "server-only";
import { getAssistantConfig } from "./assistant";
import { streamChat } from "./providers/index";
import { loadCredential, touchCredential } from "./providers/credentials";
import { recordUsage } from "./pipeline";
import {
  MEMORY_VIEW_DEF,
  MEMORY_UPDATE_DEF,
  executeMemoryView,
  executeMemoryUpdate,
} from "./tools/memory";
import { devLog } from "./dev-log";
import type { ChatMessage, ToolCallPart } from "./providers/types";
import type { ToolCtx } from "./tools/types";

/**
 * The settings-panel memory chat: a tiny bounded tool loop on the FRONTEND
 * (cheap) role, scoped to exactly the two memory tools, so users can adjust
 * what the assistant knows about them in words ("forget my old job title",
 * "actually I use metric"). Non-streamed — replies are one to three sentences.
 */

const MAX_ROUNDS = 4;
const MAX_HISTORY_TURNS = 12;

const SYSTEM =
  "You are the memory manager inside the user's settings panel. The user is reviewing the four notes the assistant keeps about them (shown next to this chat: About you, How you like replies, Your work, Rules you've given). " +
  "Use memory_view to read a note precisely and memory_update to rewrite one IN FULL exactly as the user asks — merge, never append duplicates; never invent things they didn't say; never keep health, religion, politics, sexuality, finances, ID numbers or legal matters unless they explicitly ask. " +
  "Confirm each change plainly in one to three short sentences, no headings or lists. If asked something unrelated to their memory, say this panel only manages what the assistant remembers.";

const EXECUTORS: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>
> = {
  memory_view: executeMemoryView,
  memory_update: executeMemoryUpdate,
};
const TOOL_DEFS = [MEMORY_VIEW_DEF, MEMORY_UPDATE_DEF];

export async function runMemoryChat(
  userId: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<{ reply: string }> {
  const frontend = (await getAssistantConfig()).roles.frontend;
  if (!frontend) throw new Error("The assistant isn't fully configured (no front-end model).");
  const cred = await loadCredential(frontend.credentialId);
  if (!cred) throw new Error("The front-end model's credential is missing.");
  void touchCredential(frontend.credentialId).catch(() => {});

  const ctx: ToolCtx = { userId, conversationId: "" };
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...history.slice(-MAX_HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const finalRound = round === MAX_ROUNDS;
    let text = "";
    const calls: ToolCallPart[] = [];

    // No `reasoning` here: OpenAI rejects tools + reasoning_effort on chat
    // completions for the nano models, and memory edits need none anyway.
    for await (const chunk of streamChat(
      {
        model: frontend.model,
        messages,
        ...(finalRound ? {} : { tools: TOOL_DEFS }),
      },
      cred,
    )) {
      if (chunk.type === "text") text += chunk.delta;
      else if (chunk.type === "tool_call") {
        calls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments, signature: chunk.signature });
      } else if (chunk.type === "usage") {
        await recordUsage({
          userId,
          role: "frontend",
          provider: frontend.provider,
          model: frontend.model,
          usage: chunk.usage,
        });
      } else if (chunk.type === "error") {
        throw new Error(chunk.message);
      }
    }

    if (calls.length === 0) return { reply: text.trim() || "Done." };

    messages.push({ role: "assistant", content: text, toolCalls: calls });
    for (const call of calls) {
      let result: string;
      try {
        const exec = EXECUTORS[call.name];
        result = exec
          ? await exec(JSON.parse(call.arguments || "{}"), ctx)
          : `Error: unknown tool ${call.name}.`;
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : "tool failed"}`;
      }
      devLog("debug", "memory-chat", `tool ${call.name}`, { userId, result: result.slice(0, 200) });
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: result });
    }
  }
  return { reply: "Done — your memory has been updated." };
}
