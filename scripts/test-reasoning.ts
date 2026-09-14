/**
 * Live check of per-provider reasoning passthrough + thinking streaming.
 *   node --env-file=.env --import tsx scripts/test-reasoning.ts
 * For each provider: stream a reasoning-eliciting prompt with a reasoning value
 * and report whether text, thinking summaries, and usage came back.
 */
import { getProvider } from "../src/lib/providers/registry";
import type { ChatRequest, Credential, ProviderId } from "../src/lib/providers/types";

interface Case {
  id: ProviderId;
  key?: string;
  model: string;
  reasoning: string;
  expectThinking: boolean;
}

const CASES: Case[] = [
  { id: "openai", key: process.env.OPENAI_API_KEY, model: "gpt-5.4-nano", reasoning: "low", expectThinking: false },
  { id: "anthropic-api", key: process.env.ANTHROPIC_API_KEY, model: "claude-sonnet-4-6", reasoning: "low", expectThinking: true },
  { id: "google", key: process.env.GOOGLE_API_KEY, model: "gemini-2.5-flash", reasoning: "1024", expectThinking: true },
];

function ok(cond: boolean, msg: string) {
  console.log(`    ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function run(c: Case) {
  console.log(`\n=== ${c.id} (${c.model}, reasoning="${c.reasoning}") ===`);
  if (!c.key) {
    console.log("  (no key — skipped)");
    return;
  }
  const creds: Credential = { id: "t", provider: c.id, secret: c.key };
  const req: ChatRequest = {
    model: c.model,
    messages: [
      { role: "user", content: "What is 17 * 24? Think briefly, then give the answer." },
    ],
    reasoning: c.reasoning,
    maxTokens: 2048,
  };

  let text = "";
  let thinking = "";
  let usage = null;
  let error: string | null = null;
  for await (const chunk of getProvider(c.id).streamChat(req, creds)) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "thinking") thinking += chunk.delta;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "error") error = chunk.message;
  }

  ok(!error, error ? `error: ${error}` : "no error (reasoning param accepted)");
  ok(text.includes("408"), `answer present (408) — got: ${JSON.stringify(text.trim().slice(0, 60))}`);
  ok(usage !== null, "usage reported");
  if (c.expectThinking) {
    ok(thinking.length > 0, `thinking streamed (${thinking.length} chars)`);
    if (thinking) console.log(`    thinking sample: ${JSON.stringify(thinking.trim().slice(0, 80))}…`);
  } else {
    console.log(`    (thinking not expected for this provider; got ${thinking.length} chars)`);
  }
}

for (const c of CASES) await run(c);
console.log(process.exitCode === 1 ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
