/** Smoke test for the new cost-over-time chart (Admin → Usage).
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-usage-cost-chart.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "usage-chart-smoke-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.slice(0, 150)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `usage-chart-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => {
      for (const c of cs) {
        const p = c.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    for (const range of ["hour", "day", "week", "month", "year"]) {
      const res = await fetch(`${BASE}/api/admin/usage/series?range=${range}`, {
        headers: { cookie: cookie() },
      });
      const json = await res.json();
      const p = json.points?.[0];
      check(
        `series?range=${range} has cost+requests`,
        res.status === 200 && p && "cost" in p && "requests" in p,
        JSON.stringify(p),
      );
    }

    const page = await fetch(`${BASE}/admin/usage`, { headers: { cookie: cookie() } });
    const html = await page.text();
    check("Admin → Usage renders (200)", page.status === 200, `status ${page.status}`);
    check("has the new Cost chart heading", html.includes(">Cost<"));
    check("has range buttons", ["Hour", "Day", "Week", "Month", "Year"].every((r) => html.includes(`>${r}<`)));
    check("old fixed 30-day heading is gone", !html.includes("Cost — last 30 days"));
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
