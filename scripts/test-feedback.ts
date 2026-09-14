/**
 * Live test for the thumbs-rating feedback loop (Admin → Feedback):
 * a real browser clicks 👎 on a reply → a permanent message_feedback row is
 * snapshotted (user text + rated reply + model), the frontend role writes an
 * AI "why" analysis in the background, the admin page renders it, the entry
 * SURVIVES deleting the chat, and clearing the rating removes it.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-feedback.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { recordFeedback } from "../src/lib/feedback";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "feedback-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `feedback-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "capital of France" } });
  await db.message.create({ data: { conversationId: convo.id, role: "user", content: "What is the capital of France?" } });
  const reply = await db.message.create({
    data: {
      conversationId: convo.id, role: "assistant", model: "claude-sonnet-5", provider: "anthropic-api",
      content: "The capital of France is Berlin.", // deliberately wrong — a clean 👎 story for the analyst
    },
  });

  const browser = await chromium.launch();
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();

    // 1) Rate through the REAL UI: click 👎 on the reply.
    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Bad response").click();
    await page.waitForTimeout(1200); // server action round-trip

    const row = await db.messageFeedback.findFirst({ where: { messageId: reply.id } });
    check("👎 click creates a feedback entry", !!row, row?.id ?? "none");
    check("entry snapshots the exchange", row?.userText.includes("capital of France") === true && row?.assistantText.includes("Berlin") === true);
    check("entry records rating/model/user", row?.rating === "down" && row?.model === "claude-sonnet-5" && row?.userId === user.id);

    // 2) The AI "why" analysis lands in the background (frontend role).
    let summary: string | null = null;
    for (let i = 0; i < 30 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      summary = (await db.messageFeedback.findFirst({ where: { messageId: reply.id } }))?.summary ?? null;
    }
    check("AI analysis generated", !!summary, summary?.slice(0, 140) ?? "(none after 30s)");

    // 3) Admin page renders the entry + analysis + health strip.
    await page.goto(`${BASE}/admin/feedback`, { waitUntil: "domcontentloaded" });
    check("admin page shows the entry", await page.getByText(user.email).first().isVisible());
    check("admin page shows the Bad-response chip", await page.getByText("Bad response").first().isVisible());
    check("admin page shows the AI analysis", summary ? await page.getByText("Why (AI analysis)").first().isVisible() : false);
    await page.getByText("Show the exchange").first().click();
    check("exchange expands with the rated reply", await page.getByText("The capital of France is Berlin.").first().isVisible());
    const downFilterVisible = await page.getByRole("link", { name: /👎 Bad/ }).isVisible();
    check("rating filter tabs render", downFilterVisible);

    // 4) Entry SURVIVES chat deletion (the whole point of the snapshot).
    await db.conversation.delete({ where: { id: convo.id } });
    const survivor = await db.messageFeedback.findFirst({ where: { messageId: reply.id } });
    check("entry survives deleting the conversation", !!survivor);

    // 5) Clearing a rating removes the entry (lib path — UI toggle does the same).
    await recordFeedback(user.id, reply.id, null);
    const cleared = await db.messageFeedback.findFirst({ where: { messageId: reply.id } });
    check("clearing the rating removes the entry", !cleared);

    await ctx.close();
  } finally {
    await browser.close();
    await db.messageFeedback.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL FEEDBACK CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
