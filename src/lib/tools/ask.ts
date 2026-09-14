import "server-only";
import { randomUUID } from "node:crypto";
import { openAsk } from "@/lib/ask-mailbox";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  formatAskResult,
  formatAskUnanswered,
  parseAskQuestions,
} from "@/lib/ask";
import { devLog } from "@/lib/dev-log";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx, ToolOutput } from "./types";

/**
 * `ask_user` — put a short multiple-choice card in front of the user and WAIT.
 *
 * The description below is the whole steering surface for this tool, and it is
 * doing two jobs at once. It has to make the model reach for the card at a real
 * fork in the road, and it has to stop the card becoming a permission prompt —
 * the tool directory already tells the model never to ask before acting
 * (`disclosure.ts`), and a question tool is exactly the loophole that
 * instruction would leak through. Hence the explicit "not for permission" list.
 */
export const ASK_USER_DEF: ToolDef = {
  name: "ask_user",
  description:
    `Ask the user up to ${MAX_QUESTIONS} short multiple-choice questions and WAIT for their answer, then continue this same reply with the answer in hand. ` +
    "Use it ONLY at a genuine fork in the road — where two or more answers are equally reasonable, you cannot infer which is wanted, and picking wrong would waste the work (which output format, which of several files they meant, which of two incompatible approaches, a missing detail only they know). " +
    "Do NOT use it to ask permission to act or to use a tool, to confirm an obvious next step, to check work you can verify yourself, to offer to do more afterwards, or to ask anything this conversation, the files, or the user's memory already answer — in all of those cases just do the work and say what you assumed. " +
    "One call per pause: put EVERY question you need in this one call rather than asking again later. " +
    `Each question needs ${MIN_OPTIONS}–${MAX_OPTIONS} concrete, mutually exclusive options; the user can also type their own answer or skip, so never add an "other"/"something else" option yourself. ` +
    "If they skip or dismiss, pick the most reasonable default, say which you picked, and carry on.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: `The questions to ask, in order (1–${MAX_QUESTIONS}).`,
        items: {
          type: "object",
          properties: {
            header: {
              type: "string",
              description: 'Two-word chip shown above the question, e.g. "Format", "Approach".',
            },
            question: {
              type: "string",
              description: "The question, in full, ending with a question mark.",
            },
            options: {
              type: "array",
              description: `${MIN_OPTIONS}–${MAX_OPTIONS} distinct choices.`,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice, in a few words." },
                  description: {
                    type: "string",
                    description: "Optional one-liner: what this choice means or implies.",
                  },
                },
                required: ["label"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "True if several options may be chosen together.",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

export async function executeAskUser(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolOutput> {
  const parsed = parseAskQuestions(args.questions);
  if ("error" in parsed) return { text: `Error: ${parsed.error}` };
  const { questions } = parsed;

  // No channel to the browser (the settings-panel memory chat runs tools with
  // no UI attached) — fail honestly rather than parking forever on a card
  // nobody can see.
  if (!ctx.emitEvent) {
    return {
      text:
        "Error: there's no way to show the user a question here. " +
        "[To the assistant: answer with your best assumption instead, and state it.]",
    };
  }

  const id = randomUUID();
  // Register BEFORE the card is emitted: the answer route resolves against
  // this entry, and an answer arriving first would find nothing waiting.
  // The turn's signal makes Stop release the wait immediately.
  const settled = openAsk(ctx.conversationId, id, questions, { signal: ctx.signal });
  ctx.emitEvent({ kind: "ask", id, questions });
  devLog("info", "tool", "ask_user waiting on the user", {
    conversationId: ctx.conversationId,
    askId: id,
    questions: questions.map((q) => q.question),
  });

  const result = await settled;
  devLog("info", "tool", `ask_user ${result.status}`, {
    conversationId: ctx.conversationId,
    askId: id,
    ...(result.status === "answered"
      ? { answers: result.answers.map((a) => a.chosen.join(", ") || "(skipped)") }
      : {}),
  });

  if (result.status === "answered") {
    return {
      text: formatAskResult(result.answers),
      askResult: {
        id,
        status: "answered",
        answers: result.answers,
        ...(result.by ? { by: result.by } : {}),
      },
    };
  }
  return {
    text: formatAskUnanswered(result.status),
    askResult: { id, status: result.status },
  };
}
