/**
 * Live test of the Friday weekly report (Admin → SMTP → Weekly report).
 *
 * Runs against the real database: builds the actual report, renders the actual
 * email, and drives the admin form in a browser.
 *
 *   1. The report covers a real seven-day window.
 *   2. Its totals agree with the rows it breaks down (no double counting).
 *   3. Breakdowns are ordered by cost, biggest first.
 *   4. A fixture user's spend appears against their name.
 *   5. Errors are GROUPED with counts, not listed one line per occurrence.
 *   6. Health reports the ingestion queue and probes the engines.
 *   7. The email renders both HTML and plain text, with every section.
 *   8. A hostile display name is ESCAPED, not injected into the HTML.
 *   9. The admin form saves the schedule, and the send history is preserved.
 *  10. "Send one now" is wired up.
 *
 * Writes the rendered email to logs/weekly-report-preview.html so it can be
 * eyeballed. Needs no provider keys, and sends NO email — an instance with
 * real SMTP configured must not have mail pushed through its relay just
 * because the tests ran. Restores anything it changes.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-weekly-report.ts
 *
 * To prove delivery end to end, opt in with a real address:
 *   REPORT_LIVE_SEND=you@example.com node --import tsx … scripts/test-weekly-report.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { collectWeeklyReport, getWeeklyReportConfig, setWeeklyReportConfig } from "../src/lib/weekly-report";
import { weeklyReportEmail } from "../src/lib/emails";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "report-admin-1!";
const STAMP = Date.now();
const XSS_NAME = `<img src=x onerror="alert(1)">Reporty ${STAMP}`;
const PREVIEW = join(process.cwd(), "logs", "weekly-report-preview.html");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

async function main() {
  const originalConfig = await getWeeklyReportConfig();
  const user = await db.user.create({
    data: {
      email: `report-${STAMP}@example.test`,
      // A display name that would break the email if it were interpolated raw.
      name: XSS_NAME,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  // Fixture spend + a repeated error, so the report has something to say
  // regardless of what this instance has been doing.
  await db.usageRecord.createMany({
    data: [
      { userId: user.id, provider: "anthropic-api", model: `fixture-big-${STAMP}`, role: "conversation", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costEstimate: "1.500000" },
      { userId: user.id, provider: "anthropic-api", model: `fixture-big-${STAMP}`, role: "conversation", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costEstimate: "0.250000" },
      { userId: user.id, provider: "openai", model: `fixture-small-${STAMP}`, role: "frontend", inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costEstimate: "0.010000" },
    ],
  });
  const errorIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = await db.appLog.create({
      data: { level: "error", category: "fixture", message: `Fixture failure ${STAMP}`, userId: user.id },
    });
    errorIds.push(row.id);
  }

  try {
    // --- 1–6: the gathered report ------------------------------------------
    const report = await collectWeeklyReport();
    const windowDays = (report.to.getTime() - report.from.getTime()) / 86_400_000;
    check("covers a seven-day window", Math.abs(windowDays - 7) < 0.01, `${windowDays.toFixed(3)} days`);

    const userSum = report.byUser.reduce((n, r) => n + r.cost, 0);
    const modelSum = report.byModel.reduce((n, r) => n + r.cost, 0);
    // Breakdowns are capped at the top 20, so they can only ever be ≤ total.
    check(
      "totals agree with the breakdowns (nothing double counted)",
      userSum <= report.spend.cost + 1e-6 && modelSum <= report.spend.cost + 1e-6,
      `total ${report.spend.cost.toFixed(4)} · users ${userSum.toFixed(4)} · models ${modelSum.toFixed(4)}`,
    );

    const sortedByCost = (rows: { cost: number }[]) =>
      rows.every((r, i) => i === 0 || rows[i - 1].cost >= r.cost);
    check("breakdowns are ordered by cost, biggest first", sortedByCost(report.byUser) && sortedByCost(report.byModel));

    const mine = report.byUser.find((r) => r.label === XSS_NAME);
    check(
      "the fixture user's spend is attributed to them",
      !!mine && Math.abs(mine.cost - 1.76) < 0.001 && mine.requests === 3,
      mine ? `${mine.requests} requests, $${mine.cost.toFixed(2)}` : "user not in breakdown",
    );

    const grouped = report.errors.find((e) => e.message.includes(`Fixture failure ${STAMP}`));
    check(
      "identical errors are grouped with a count",
      !!grouped && grouped.count === 3,
      grouped ? `count ${grouped.count}` : "fixture error missing",
    );

    check(
      "health reports the ingestion queue and probes the engines",
      Number.isInteger(report.health.pendingFiles) &&
        Number.isInteger(report.health.stuckFiles) &&
        Array.isArray(report.health.engines),
      `pending ${report.health.pendingFiles} · stuck ${report.health.stuckFiles} · ` +
        (report.health.engines.map((e) => `${e.name}=${e.ok ? "ok" : "down"}`).join(", ") || "no engines configured"),
    );

    // --- 7/8: the rendered email -------------------------------------------
    const mail = await weeklyReportEmail(report);
    // Hand-sent copies are marked TEST (2026-09-02); the scheduled one is not.
    const testMail = await weeklyReportEmail(report, { test: true });
    check("a hand-sent report is marked TEST in the subject", testMail.subject.startsWith("[TEST] "), testMail.subject);
    check("…and carries a TEST banner in the body", /TEST SEND/.test(testMail.html) && /TEST SEND/.test(testMail.text));
    check("the scheduled render has no TEST marker", !/TEST/.test(mail.subject) && !/TEST SEND/.test(mail.html));
    check(
      "the Claude-plan section names sessions, the plan reading and the API fallback",
      report.subscription.requests === 0 || (/Sandbox sessions/.test(mail.html) && /Plan right now/.test(mail.html) && /Fell back to the API key/.test(mail.html)),
      `plan requests this week: ${report.subscription.requests}`,
    );
    await writeFile(PREVIEW, mail.html, "utf8");
    const sections = ["Weekly report", "Spend by person", "Spend by model", "Errors", "Health"];
    const missing = sections.filter((s) => !mail.html.includes(s));
    check("the email renders every section", missing.length === 0, missing.join(", "));
    check(
      "the plain-text alternative is populated too",
      /weekly report/i.test(mail.text) && mail.text.includes("Health:") && mail.text.length > 200,
    );
    check("the subject carries the week's spend", /\$\d/.test(mail.subject), mail.subject);

    // The raw tag must never survive into the HTML; the escaped form must.
    check(
      "a hostile display name is escaped, not injected",
      !mail.html.includes('<img src=x onerror="alert(1)">') &&
        mail.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
    );

    // --- 9/10: the admin form ------------------------------------------------
    const jar = new Map<string, string>();
    const store = (cs: string[]) => {
      for (const c of cs) {
        const p = c.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
    };
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    // Pretend a report already went out, so we can prove saving the schedule
    // doesn't wipe the history (which would re-send immediately).
    await setWeeklyReportConfig({ ...originalConfig, lastRunLocalDate: "2000-01-01", lastRunAt: "2000-01-01T17:00:00.000Z" });

    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1100 } });
      await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/smtp`, { waitUntil: "domcontentloaded" });
      await page.locator("#report-email").waitFor({ state: "visible", timeout: 20_000 });

      await page.locator("#report-email").fill("weekly@example.test");
      await page.locator("#report-weekday").selectOption("Fri");
      await page.locator("#report-hour").selectOption("17");
      await page.getByRole("button", { name: /save report settings/i }).click();
      await page.getByText(/weekly report (will be sent|is switched off)/i).waitFor({ timeout: 20_000 });

      const saved = await getWeeklyReportConfig();
      check(
        "the admin form saves the schedule",
        saved.email === "weekly@example.test" && saved.weekday === "Fri" && saved.hourLocal === 17,
        `${saved.weekday} ${saved.hourLocal}:00 → ${saved.email}`,
      );
      check(
        "saving preserves the send history (won't re-send immediately)",
        saved.lastRunLocalDate === "2000-01-01",
        `lastRunLocalDate=${saved.lastRunLocalDate}`,
      );

      // "Send one now" is deliberately NOT clicked by default: this instance
      // has real SMTP configured, and a test run must not push mail through
      // the owner's relay as a side effect. Set REPORT_LIVE_SEND=<address> to
      // opt into a genuine end-to-end delivery.
      const sendNow = page.getByRole("button", { name: /send one now/i });
      check("'Send one now' is present and enabled", await sendNow.isEnabled());

      const liveTo = process.env.REPORT_LIVE_SEND;
      if (liveTo) {
        await page.locator("#report-email").fill(liveTo);
        await sendNow.click();
        const outcome = page.getByText(/(report sent to|no smtp configured|failed to send)/i);
        await outcome.first().waitFor({ timeout: 120_000 });
        const msg = (await outcome.first().textContent()) ?? "";
        check("a real report was delivered", /report sent to/i.test(msg), msg);
      } else {
        console.log("  · skipped live delivery (set REPORT_LIVE_SEND=you@example.com to send for real)");
      }
    } finally {
      await browser.close();
    }
  } finally {
    await setWeeklyReportConfig(originalConfig).catch(() => {});
    const restored = await getWeeklyReportConfig().catch(() => null);
    check(
      "the instance's original report config was restored",
      restored?.email === originalConfig.email && restored?.enabled === originalConfig.enabled,
    );
    await db.appLog.deleteMany({ where: { id: { in: errorIds } } }).catch(() => {});
    // usage_records use SET NULL on user delete, so the fixture rows must go
    // explicitly or they'd linger as anonymous spend in every future report.
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\nPreview written to ${PREVIEW}`);
  console.log(`${failures === 0 ? "ALL WEEKLY-REPORT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
