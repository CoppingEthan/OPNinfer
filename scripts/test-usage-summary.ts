/**
 * Live test for the revamped Admin → Usage dashboard: the consolidated
 * /api/admin/usage/summary endpoint (one window drives series + totals +
 * prev-window deltas + all breakdowns + recent feed, and they must agree),
 * plus a headless-browser render of the dashboard itself.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-usage-summary.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "usage-sum-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
  if (!ok) failures++;
}

type Summary = {
  range: string;
  points: { t: string; in: number; out: number; cached: number; cost: number; requests: number }[];
  totals: { cost: number; requests: number; in: number; out: number; cacheRead: number; users: number };
  prev: { cost: number; requests: number } | null;
  byRole: { key: string; cost: number; requests: number }[];
  byProvider: { key: string; cost: number }[];
  byModel: { key: string; sub?: string; cost: number }[];
  byUser: { key: string; cost: number; in: number; out: number; requests: number }[];
  recent: { t: string; user: string; model: string; role: string; cost: number }[];
};

async function main() {
  const admin = await db.user.create({
    data: { email: `usage-sum-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const plain = await db.user.create({
    data: { email: `usage-plain-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  // Seed a recognizable usage fingerprint: 3 calls now + 1 in the previous
  // hour-window (feeds the delta), under a model name no real traffic uses.
  const MODEL = "summary-test-model";
  const now = Date.now();
  const mk = (offsetMs: number, role: string, tokens: number) =>
    db.usageRecord.create({
      data: {
        userId: admin.id, provider: "openai", model: MODEL, role,
        inputTokens: tokens, outputTokens: tokens * 2, cacheReadTokens: tokens * 3,
        costEstimate: "0.010000", createdAt: new Date(now - offsetMs),
      },
    });
  await Promise.all([mk(5_000, "conversation", 100), mk(10_000, "escalation", 50), mk(15_000, "frontend", 10)]);
  await mk(45 * 60_000, "conversation", 100); // previous hour-window only

  const browser = await chromium.launch();
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const login = async (email: string) => {
      jar.clear();
      const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
      const { csrfToken } = await r1.json() as { csrfToken: string };
      const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email, password: PASSWORD }), redirect: "manual" });
      store(r2.headers.getSetCookie());
    };

    // Non-admin is refused.
    await login(plain.email);
    const forbidden = await fetch(`${BASE}/api/admin/usage/summary?range=day`, { headers: { cookie: cookie() } });
    check("non-admin gets 403", forbidden.status === 403, `status ${forbidden.status}`);

    await login(admin.email);
    const get = async (range: string): Promise<Summary> => {
      const res = await fetch(`${BASE}/api/admin/usage/summary?range=${range}`, { headers: { cookie: cookie() } });
      check(`GET summary range=${range} → 200`, res.status === 200, `status ${res.status}`);
      return res.json() as Promise<Summary>;
    };

    // Every range returns a coherent payload.
    for (const range of ["hour", "day", "week", "month", "year", "all"]) {
      const s = await get(range);
      const pCost = s.points.reduce((a, p) => a + p.cost, 0);
      const pReq = s.points.reduce((a, p) => a + p.requests, 0);
      check(`  [${range}] series sums match totals`, Math.abs(pCost - s.totals.cost) < 1e-6 && pReq === s.totals.requests,
        `Σpoints ${pCost.toFixed(6)}/${pReq} vs totals ${s.totals.cost.toFixed(6)}/${s.totals.requests}`);
      const roleCost = s.byRole.reduce((a, r) => a + r.cost, 0);
      const modelCost = s.byModel.reduce((a, r) => a + r.cost, 0);
      const userCost = s.byUser.reduce((a, r) => a + r.cost, 0);
      check(`  [${range}] breakdowns each sum to the total`,
        Math.abs(roleCost - s.totals.cost) < 1e-6 && Math.abs(modelCost - s.totals.cost) < 1e-6 && Math.abs(userCost - s.totals.cost) < 1e-6,
        `role ${roleCost.toFixed(4)} model ${modelCost.toFixed(4)} user ${userCost.toFixed(4)} total ${s.totals.cost.toFixed(4)}`);
      check(`  [${range}] prev window ${range === "all" ? "omitted" : "present"}`, range === "all" ? s.prev === null : s.prev !== null);
    }

    // The seeded fingerprint shows up everywhere it should (hour window).
    const hour = await get("hour");
    const seededModel = hour.byModel.find((m) => m.key === MODEL);
    const seededUser = hour.byUser.find((u) => u.key === admin.email);
    check("seeded model appears in byModel with provider sub", !!seededModel && seededModel.sub === "openai", JSON.stringify(seededModel));
    check("seeded user appears in byUser with 3 requests", !!seededUser && seededUser.requests >= 3, JSON.stringify(seededUser));
    check("seeded rows in recent feed carry email + model", hour.recent.some((r) => r.user === admin.email && r.model === MODEL));
    check("roles broken out (conversation + escalation + frontend)",
      ["conversation", "escalation", "frontend"].every((role) => hour.byRole.some((r) => r.key === role)));
    check("active users counted", hour.totals.users >= 1, `users=${hour.totals.users}`);

    // Dashboard renders in a real browser.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${BASE}/admin/usage`, { waitUntil: "domcontentloaded" });

    check("KPI cards render", await page.getByText("Avg cost / request").isVisible());
    check("range selector renders all six ranges",
      (await Promise.all(["Hour", "Day", "Week", "Month", "Year", "All"].map((l) => page.getByRole("button", { name: l, exact: true }).isVisible()))).every(Boolean));
    check("breakdown cards render", await page.getByText("By model").isVisible() && await page.getByText("Recent activity").isVisible());
    check("seeded model visible in the page", await page.getByText(MODEL).first().isVisible());

    // Switching range refetches with the new range param.
    const refetch = page.waitForRequest((r) => r.url().includes("/api/admin/usage/summary?range=hour"));
    await page.getByRole("button", { name: "Hour", exact: true }).click();
    await refetch;
    check("range switch refetches the summary", true);
    await page.waitForTimeout(600);
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await db.usageRecord.deleteMany({ where: { model: "summary-test-model" } }).catch(() => {});
    await db.user.delete({ where: { id: admin.id } }).catch(() => {});
    await db.user.delete({ where: { id: plain.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL USAGE-SUMMARY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
