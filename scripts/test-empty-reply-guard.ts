/**
 * Live regression for the EMPTY-REPLY bug (owner chat ea8bec45): the model
 * spent all 6 tool rounds searching without writing text, then tried ANOTHER
 * tool call in the forced-final round (models imitate tool_use from their own
 * transcript even when the tool isn't offered) — the call was silently
 * dropped, the turn ended with zero text, nothing was saved, and after a
 * refresh the user saw only their own message.
 *
 * Fixes under test (pipeline.ts + route.ts):
 *  1. Final round injects a "tool budget exhausted — answer now" notice.
 *  2. If a loop still ends with no text → a guaranteed tool-free answer pass.
 *  3. Route: a turn that truly produces nothing sends an honest error event.
 * Plus: claude-sonnet-5 now has a pricing entry (was logging $0).
 *
 * The prompt deliberately instructs MORE searches than the round budget so
 * the turn exhausts its rounds exactly like the real failure.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-empty-reply-guard.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "empty-guard-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `empty-guard-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const started = new Date();
  let convId: string | null = null;
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: null,
        content:
          "Research task with strict protocol: perform 12 web_search calls about the history of lighthouses, ONE AT A TIME — each next query must be refined based on the previous result, so never issue more than ONE tool call per step. Do not write ANY prose or summary until all 12 sequential searches are complete.",
      }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);
    let full = ""; const reader = res.body?.getReader(); const dec = new TextDecoder();
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); } }

    const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; } });
    convId = (events.find((e) => e.type === "meta") as { conversationId?: string } | undefined)?.conversationId ?? null;
    const toolEvents = events.filter((e) => e.type === "tool");
    const text = events.filter((e) => e.type === "text").map((e) => e.delta as string).join("");
    const doneEvt = events.find((e) => e.type === "done") as { messageId?: string | null } | undefined;

    check("tool rounds actually ran", toolEvents.length >= 4, `${toolEvents.length} tool status events`);
    check("reply text was produced despite tool exhaustion", text.trim().length > 50, `${text.trim().length} chars`);
    check("no error event", !events.some((e) => e.type === "error"), JSON.stringify(events.find((e) => e.type === "error") ?? {}));
    check("done carries a saved messageId (reply persisted)", !!doneEvt?.messageId, String(doneEvt?.messageId));

    // The reply must survive a "refresh": the assistant row exists in the DB.
    if (doneEvt?.messageId) {
      const saved = await db.message.findUnique({ where: { id: doneEvt.messageId } });
      check("assistant message row exists with content", !!saved && saved.role === "assistant" && saved.content.length > 0, `len=${saved?.content.length}`);
    }

    // Pricing fix: this turn's sonnet-5 usage rows must carry real cost now.
    const usage = await db.usageRecord.findMany({
      where: { userId: user.id, model: { startsWith: "claude-sonnet-5" }, createdAt: { gte: started } },
    });
    check("round budget was genuinely exhausted (≥7 model calls)", usage.length >= 7, `${usage.length} conversation-model calls`);
    check("sonnet-5 cost is no longer $0 (pricing entry added)", usage.length > 0 && usage.every((u) => Number(u.costEstimate) > 0),
      usage.slice(0, 5).map((u) => `$${Number(u.costEstimate).toFixed(6)}`).join(", "));
  } finally {
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL EMPTY-REPLY-GUARD CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
