/**
 * Live regression for the truncation bug that cost a real user four rounds
 * (chat baf29809, 2026-07-29): every substantive turn stopped at exactly 4096
 * output tokens, cutting the model off mid-tool-call, so the .docx it kept
 * promising could never be produced. Nothing errored — a truncated response is
 * a successful API call — so the only symptom was a frustrated user.
 *
 * Root cause: Anthropic's non-thinking default was 4096, chosen on the
 * assumption that omitting `thinking` meant the model wasn't thinking. Claude
 * Sonnet 5 runs adaptive thinking by default when `thinking` is omitted, so
 * thinking silently consumed the budget.
 *
 * This recreates the shape — ask for a real file, which forces tool rounds and
 * a long reply — and asserts the turn is NOT truncated and the file lands.
 *
 * Needs provider keys + the sandbox broker (it writes a file):
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx \
 *     --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-output-limit.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { getTokenLimits } from "../src/lib/limits";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "limits-test-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
  );
  if (!ok) failures++;
}

async function main() {
  const limits = await getTokenLimits();
  check(
    "instance output ceiling is generous",
    limits.maxOutputTokens >= 32_000,
    `${limits.maxOutputTokens.toLocaleString()} tokens`,
  );

  const email = `limits-${Date.now()}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
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
      body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1400, height: 900 },
    });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();

    // The failing shape: a request that needs tool rounds AND a long answer.
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    const ta = page.locator("textarea");
    await ta.fill(
      "Write about 700 words of website copy for a fictional shutters company, " +
        "then save it as a .docx file and present it to me.",
    );
    await ta.press("Enter");
    await page.waitForFunction(
      `(() => {
        const b = document.querySelectorAll("[data-role='assistant']");
        const last = b[b.length - 1];
        return !!last && !!last.querySelector("[aria-label='Retry']");
      })()`,
      undefined,
      { timeout: 300_000 },
    );
    convId = await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null);
    check("conversation was created", !!convId, convId ?? "—");

    // 1. The turn must not have hit the ceiling — that's the bug.
    const usage = await db.usageRecord.findMany({
      where: { userId: user.id, role: "conversation" },
      orderBy: { createdAt: "desc" },
    });
    const atCeiling = usage.filter((u) => u.outputTokens >= limits.maxOutputTokens);
    check(
      "no turn was truncated at the output ceiling",
      atCeiling.length === 0,
      `${usage.length} calls, max ${Math.max(0, ...usage.map((u) => u.outputTokens))} out`,
    );
    // The old failure was a hard stop at exactly 4096 — assert it explicitly,
    // since that number is what a reintroduced small default would produce.
    check(
      "no turn stopped at the old 4096 default",
      !usage.some((u) => u.outputTokens === 4096),
    );

    // 2. The file the user actually asked for exists and was presented.
    const files = convId
      ? await db.file.findMany({ where: { conversationId: convId } })
      : [];
    check(
      "a document was produced",
      files.some((f) => /\.docx?$/i.test(f.filename)),
      files.map((f) => f.filename).join(", ") || "none",
    );

    const lastReply = convId
      ? await db.message.findFirst({
          where: { conversationId: convId, role: "assistant" },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const presented = (lastReply?.meta as { fileIds?: string[] } | null)?.fileIds ?? [];
    check("the file was presented to the user", presented.length > 0);
    check(
      "the reply is substantial, not a stub",
      (lastReply?.content.length ?? 0) > 200,
      `${lastReply?.content.length ?? 0} chars`,
    );
    await ctx.close();
  } finally {
    await browser.close();
    if (convId) await db.conversation.deleteMany({ where: { id: convId } });
    await db.user.deleteMany({ where: { id: user.id } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
