/**
 * Probe — the plan-usage alert emails (owner ask 2026-09-02): feed the
 * recorder fake readings (91%, then 100%, then 100% again) and show which
 * ERROR-level rows landed in the app log — those are exactly what Admin →
 * SMTP's error alerts mail. Restores the real readings afterwards.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/probe-plan-alerts.ts
 */
import { db } from "../src/lib/db";
import { recordPlanUsage } from "../src/lib/agent/limits-store";

try { process.loadEnvFile(".env"); } catch { /* env present */ }

const KEY = "agent_rate_limits";
// Fixed reset times: a real window's reset time does not move between readings.
const RESET_5H = new Date(Date.now() + 3_600_000).toISOString();
const RESET_7D = new Date(Date.now() + 5 * 86_400_000).toISOString();
const usage = (pct5h: number, pct7d: number) => ({
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: pct5h, resets_at: RESET_5H },
    seven_day: { utilization: pct7d, resets_at: RESET_7D },
  },
});

async function main() {
  const prior = await db.setting.findUnique({ where: { key: KEY } });
  const since = new Date();
  try {
    await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: {} }, update: { value: {} } });
    const steps: [string, number, number][] = [
      ["session 45%, week 20% (nothing expected)", 45, 20],
      ["session 91% (expect: nearing)", 91, 20],
      ["session 94% (expect: nothing new)", 94, 20],
      ["session 100% (expect: limit reached)", 100, 20],
      ["session 100% again, week 92% (expect: week nearing only)", 100, 92],
    ];
    for (const [label, a, b] of steps) {
      const before = await db.appLog.count({ where: { category: "agent", level: "error", createdAt: { gte: since } } });
      await recordPlanUsage(usage(a, b));
      const rows = await db.appLog.findMany({ where: { category: "agent", level: "error", createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
      const fresh = rows.slice(before).map((r) => r.message);
      console.log(`${label} → ${fresh.length ? fresh.join(" | ") : "(no new alert)"}`);
    }
    console.log("\nemail path: Admin → SMTP → 'Email me when an error occurs' mails every ERROR row above (throttled per message).");
  } finally {
    if (prior) await db.setting.update({ where: { key: KEY }, data: { value: prior.value as object } });
    else await db.setting.deleteMany({ where: { key: KEY } });
    await db.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
