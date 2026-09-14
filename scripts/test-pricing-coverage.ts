/**
 * Live check: every model this instance actually USES has a pricing entry.
 *
 * A model missing from `providers/pricing.ts` doesn't error — `estimateCost`
 * returns 0 by design rather than inventing a rate, so its calls log real
 * token counts at a cost of ZERO and the Usage dashboard quietly understates
 * spend. That has now happened twice: once when claude-sonnet-5 was bound as
 * the conversation model (236 rows backfilled), and again on the first
 * production instance stood up, where three of the four bound roles — including the
 * Opus escalation model — had no entry.
 *
 * Run this after changing anything in Admin → Models:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env \
 *     scripts/test-pricing-coverage.ts
 *
 * Add `--fix` to re-price historical usage_records rows that logged $0 for a
 * model that now HAS rates (the backfill; prints a dry-run summary without it).
 */
import { db } from "../src/lib/db";
import { ratesFor, estimateCost } from "../src/lib/providers/pricing";
import { getAssistantConfig, type AssistantRole } from "../src/lib/assistant";

const FIX = process.argv.includes("--fix");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // --- 1. Every bound assistant role resolves to a rate ---------------------
  const config = await getAssistantConfig();
  const roles: AssistantRole[] = ["frontend", "conversation", "escalation", "failover"];
  for (const role of roles) {
    const bound = config.roles[role];
    if (!bound?.model) {
      console.log(`· ${role}: not configured — skipped`);
      continue;
    }
    const rates = ratesFor(bound.model);
    check(
      `${role} model "${bound.model}" is priced`,
      !!rates,
      rates
        ? `in ${rates.input} / out ${rates.output} / cacheRead ${rates.cacheRead} / cacheWrite ${rates.cacheWrite} per 1M`
        : "NO PRICING ENTRY — every call by this role logs $0",
    );
  }

  // --- 2. No model in the usage ledger is silently free ---------------------
  // Group by model rather than scanning rows: a busy instance has plenty.
  const used = await db.usageRecord.groupBy({
    by: ["model", "provider"],
    _count: { _all: true },
    _sum: { costEstimate: true, inputTokens: true, outputTokens: true },
  });

  for (const row of used) {
    // Image tools bill a flat per-image cost that never goes through RATES.
    if (row.model.includes("-image")) {
      console.log(`· ${row.model}: flat per-image billing — not rate-based, skipped`);
      continue;
    }
    const tokens = (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0);
    const cost = Number(row._sum.costEstimate ?? 0);
    const rates = ratesFor(row.model);
    check(
      `used model "${row.model}" (${row._count._all} calls) is priced`,
      !!rates,
      rates ? `logged $${cost.toFixed(4)}` : `${tokens} tokens logged at $0`,
    );
    if (rates && tokens > 0 && cost === 0) {
      check(
        `"${row.model}" has non-zero cost recorded`,
        false,
        "rates exist now but historical rows are $0 — re-run with --fix to backfill",
      );
    }
  }

  // --- 3. Backfill rows priced before their rates existed -------------------
  const stale = await db.usageRecord.findMany({
    where: { costEstimate: 0 },
    select: {
      id: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
    },
  });
  const repriceable = stale
    .map((r) => ({
      id: r.id,
      model: r.model,
      cost: estimateCost(r.model, {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
      }),
    }))
    .filter((r) => r.cost > 0);

  if (repriceable.length === 0) {
    console.log("· no $0 rows are repriceable — nothing to backfill");
  } else {
    const total = repriceable.reduce((sum, r) => sum + r.cost, 0);
    const byModel = new Map<string, number>();
    for (const r of repriceable) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    console.log(
      `${FIX ? "▸ backfilling" : "· would backfill"} ${repriceable.length} rows ` +
        `($${total.toFixed(4)}): ${[...byModel].map(([m, n]) => `${m}×${n}`).join(", ")}`,
    );
    if (FIX) {
      for (const r of repriceable) {
        await db.usageRecord.update({
          where: { id: r.id },
          data: { costEstimate: r.cost },
        });
      }
      console.log(`✓ backfilled ${repriceable.length} rows`);
    } else {
      console.log("  (re-run with --fix to apply)");
    }
  }

  console.log(failures === 0 ? "\nAll pricing checks passed." : `\n${failures} check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
