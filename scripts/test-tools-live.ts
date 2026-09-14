/**
 * Live tool round-trip smoke (NOT in the test suite; costs a few tokens).
 * For every org credential in the DB, offers date_time_now, expects the model
 * to call it, executes it, feeds the result back, and checks the final answer
 * — proving the full tool loop path (schema out, tool_call in, tool result
 * out, answer in) per provider.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-tools-live.ts
 */
import { db } from "../src/lib/db";
import { streamChat } from "../src/lib/providers/index";
import { loadCredential } from "../src/lib/providers/credentials";
import { toProviderId } from "../src/lib/providers/mapping";
import {
  DATE_TIME_NOW_DEF,
  executeDateTimeNow,
} from "../src/lib/tools/date-time";
import type { ChatMessage, ProviderId } from "../src/lib/providers/types";

const MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.4-mini",
  "anthropic-api": "claude-haiku-4-5",
  google: "gemini-3.5-flash",
};

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function collect(
  providerId: ProviderId,
  model: string,
  messages: ChatMessage[],
  credId: string,
) {
  const cred = await loadCredential(credId);
  if (!cred) throw new Error("credential failed to load");
  let text = "";
  const calls: { id: string; name: string; args: string; signature?: string }[] = [];
  for await (const chunk of streamChat({ model, messages, tools: [DATE_TIME_NOW_DEF] }, cred)) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "tool_call") {
      calls.push({ id: chunk.id, name: chunk.name, args: chunk.arguments, signature: chunk.signature });
    } else if (chunk.type === "error") throw new Error(chunk.message);
  }
  return { text, calls };
}

async function main() {
  const rows = await db.providerCredential.findMany();
  if (rows.length === 0) throw new Error("No org credentials in the DB.");

  const seen = new Set<ProviderId>();
  for (const row of rows) {
    const pid = toProviderId(row.provider);
    if (seen.has(pid)) continue;
    seen.add(pid);
    const model = MODELS[pid];
    console.log(`\n— ${pid} (${model}) —`);

    try {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content:
            "What is the current date and time in Tokyo right now? You MUST call the date_time_now tool to find out — do not answer from your own knowledge.",
        },
      ];
      const r1 = await collect(pid, model, messages, row.id);
      const call = r1.calls.find((c) => c.name === "date_time_now");
      check(`${pid}: model called date_time_now`, !!call, JSON.stringify(r1.calls));
      if (!call) continue;

      const result = await executeDateTimeNow(JSON.parse(call.args || "{}"));
      check(`${pid}: tool executed with model args`, result.includes("Tokyo") || result.includes("Asia"), call.args);

      messages.push({
        role: "assistant",
        content: r1.text,
        toolCalls: [
          { id: call.id, name: call.name, arguments: call.args, signature: call.signature },
        ],
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: result,
      });
      const r2 = await collect(pid, model, messages, row.id);
      const year = new Date().getUTCFullYear().toString();
      check(
        `${pid}: final answer uses the tool result`,
        r2.text.length > 0 && (r2.text.includes(year) || /\d{1,2}:\d{2}/.test(r2.text)),
        r2.text.slice(0, 140).replace(/\n/g, " "),
      );
    } catch (e) {
      check(`${pid}: round-trip`, false, e instanceof Error ? e.message : String(e));
    }
  }

  await db.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PROVIDER TOOL ROUND-TRIPS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
