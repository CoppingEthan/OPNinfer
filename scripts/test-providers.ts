/**
 * Live integration check for the provider layer. Run against real keys in .env:
 *   node --env-file=.env --import tsx scripts/test-providers.ts
 *
 * For each provider with a key present: list models, then stream a tiny chat
 * and print the NORMALIZED usage + computed cost. Not part of the test suite —
 * a manual smoke test that hits real APIs.
 */
import { getProvider } from "../src/lib/providers/registry";
import { estimateCost } from "../src/lib/providers/pricing";
import type { ChatRequest, Credential, ProviderId, TokenUsage } from "../src/lib/providers/types";

async function run(
  id: ProviderId,
  secret: string | undefined,
  prefer: string[],
) {
  console.log(`\n=== ${id} ===`);
  if (!secret) {
    console.log("  (no key in env — skipped)");
    return;
  }
  const provider = getProvider(id);
  const creds: Credential = { id: "live-test", provider: id, secret };

  let models;
  try {
    models = await provider.listModels(creds);
    console.log(`  listModels: ${models.length} models`);
    console.log(`    sample: ${models.slice(0, 6).map((m) => m.id).join(", ")}`);
  } catch (e) {
    console.log(`  listModels FAILED: ${(e as Error).message}`);
    models = provider.fallbackModels();
    console.log(`    using fallback: ${models.map((m) => m.id).join(", ")}`);
  }

  // Pick a cheap available model: exact id match first, then substring.
  const pick =
    prefer.map((p) => models!.find((m) => m.id === p)?.id).find(Boolean) ??
    prefer.map((p) => models!.find((m) => m.id.includes(p))?.id).find(Boolean) ??
    models![0]?.id;
  if (!pick) {
    console.log("  no model to test");
    return;
  }
  console.log(`  streamChat model: ${pick}`);

  const req: ChatRequest = {
    model: pick,
    messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
    maxTokens: 50,
  };

  let text = "";
  let usage: TokenUsage | null = null;
  let error: string | null = null;
  for await (const chunk of provider.streamChat(req, creds)) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "error") error = chunk.message;
  }

  console.log(`  reply: ${JSON.stringify(text.trim())}`);
  if (error) console.log(`  ERROR: ${error}`);
  if (usage) {
    console.log(`  usage: ${JSON.stringify(usage)}`);
    console.log(`  cost:  $${estimateCost(pick, usage).toFixed(8)}`);
  }
}

await run("openai", process.env.OPENAI_API_KEY, [
  "nano",
  "mini",
  "gpt-5.4",
  "gpt-4o",
]);
await run("anthropic-api", process.env.ANTHROPIC_API_KEY, [
  "haiku",
  "sonnet",
]);
await run("google", process.env.GOOGLE_API_KEY, [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-flash-latest",
]);

console.log("\nDONE");
