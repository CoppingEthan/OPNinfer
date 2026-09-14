/**
 * Context-curation live smoke (NOT in the test suite; a few cheap frontend-
 * model calls). Replaces test-router-curation.ts — the tool router was
 * retired in favour of model-driven progressive disclosure (see
 * src/lib/tools/disclosure.ts + scripts/test-tool-disclosure.ts).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-curation.ts
 */
import { getAssistantConfig } from "../src/lib/assistant";
import { curateOldToolResults, estimateTokens } from "../src/lib/tools/curation";
import { db } from "../src/lib/db";
import type { ChatMessage } from "../src/lib/providers/types";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const config = await getAssistantConfig();
  if (!config.roles.frontend) throw new Error("No frontend role configured.");

  // --- curation on a heavy synthetic transcript ------------------------------
  const big = "The quick brown fox. ".repeat(11000); // ~231k chars ≈ 58k tokens each
  const messages: ChatMessage[] = [
    { role: "user", content: "analyse these" },
    { role: "tool", toolCallId: "1", toolName: "web_scrape", content: `PageA numbers: revenue £4.2m, growth 12%, deadline 2026-09-01. ${big}` },
    { role: "tool", toolCallId: "2", toolName: "memory_view", content: `MEMORIES ${big.slice(0, 2000)}` },
    { role: "tool", toolCallId: "3", toolName: "web_scrape", content: `PageB: contact sales@acme.test, price $99. ${big}` },
    { role: "assistant", content: "working on it" },
    // 5 recent tool results that must remain untouched
    ...Array.from({ length: 5 }, (_, i): ChatMessage => ({
      role: "tool", toolCallId: `r${i}`, toolName: "read_file", content: `recent result ${i} ${"z".repeat(600)}`,
    })),
    { role: "user", content: "so?" },
  ];
  const before = estimateTokens(messages);
  const res = await curateOldToolResults(config, messages);
  const after = estimateTokens(messages);

  check("curation triggered on a >100k-token transcript", before > 100_000 && res.curatedCount > 0, `before=${before} curated=${res.curatedCount}`);
  check("…both big web results curated, memory op untouched",
    res.curatedCount === 2 && messages[2].content.startsWith("MEMORIES"),
  );
  check("…recent results kept at full fidelity", messages[6].content.startsWith("recent result"));
  check(
    "…summaries preserve key facts (revenue figure survives)",
    messages[1].content.includes("[Tool result curated") && /4\.2|£4\.2m|4,200,000/.test(messages[1].content),
    messages[1].content.slice(0, 200),
  );
  check("…token estimate collapsed", after < before / 3, `after=${after}`);
  check("…summarizer usage returned", !!res.usage && res.usage.outputTokens > 0);

  await db.$disconnect();
  console.log(`\n${failures === 0 ? "ALL CURATION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
