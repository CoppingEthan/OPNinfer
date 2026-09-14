/**
 * Live regression for two behavioral bugs found in owner testing (chat
 * f2d0b8b7): (1) the model REFUSED an explicit "escalate to the powerful
 * model" request (old steering only covered too-hard tasks), and (2) it
 * falsely "confessed" that its earlier web-searched reply was invented,
 * because replayed history carries no tool trace. Fixes: escalate-on-request
 * steering (pipeline.ts) + provenance notes on replayed assistant turns
 * (provenance.ts, wired in the chat route).
 *
 * This harness seeds the EXACT failure shape — a sourced news reply in
 * history, then an explicit escalate request — and asserts the escalation
 * role actually runs.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-escalate-request.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "esc-req-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `esc-req-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "escalate request" } });
  // History mirroring the real failure: a news question + a SOURCED reply.
  await db.message.create({ data: { conversationId: convo.id, role: "user", content: "What is the latest news and what are your thoughts?" } });
  await db.message.create({
    data: {
      conversationId: convo.id, role: "assistant",
      content: "Here's a snapshot of today's headlines: markets steadied after the central-bank decision; a major earthquake recovery operation continues; and a new AI-policy framework was announced in the EU.",
      meta: { sources: [
        { url: "https://www.npr.org/sections/news", title: "NPR News" },
        { url: "https://www.bbc.com/news/world", title: "BBC World" },
        { url: "https://apnews.com/world-news", title: "AP World" },
      ] },
    },
  });

  const started = new Date();
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
      body: JSON.stringify({ conversationId: convo.id, content: "can you escalate to the powerful model and get its thoughts" }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);
    let full = ""; const reader = res.body?.getReader(); const dec = new TextDecoder();
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); } }

    const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; } });
    check("stream completed (done event)", events.some((e) => e.type === "done"));
    check("no error event", !events.some((e) => e.type === "error"), JSON.stringify(events.find((e) => e.type === "error") ?? {}));

    const text = events.filter((e) => e.type === "text").map((e) => e.delta as string).join("");
    check("produced a real reply", text.trim().length > 100, `${text.length} chars`);

    // The core assertion: the escalation role RAN (usage row tagged escalation).
    const esc = await db.usageRecord.findMany({
      where: { userId: user.id, role: "escalation", createdAt: { gte: started } },
    });
    check("escalation model was invoked (role=escalation usage recorded)", esc.length > 0,
      esc.map((u) => `${u.model} out=${u.outputTokens}`).join(", ") || "none");

    // And the reply must not disown the (provenance-annotated) sourced turn.
    const denial = /wasn'?t (actually )?pulled from a live search|invented headlines|don'?t have (automatic )?real-?time browsing/i;
    check("no false confession about the earlier sourced reply", !denial.test(text));

    // The ESCALATED model must know it IS the bigger model (observed live:
    // Opus opened with "I don't have a way to ask a bigger model" — while
    // being the bigger model). The hand-off now carries an escalation context
    // note, so any "can't reach a bigger model" denial is a regression.
    const denyBigger =
      /don'?t have (a way|access|the ability) to (ask|reach|use|escalate)|no such tool available|can(?:'|no)t (ask|access|escalate to) (a |the )?(bigger|larger|more (capable|powerful)|smarter) model/i;
    check("escalated reply doesn't deny being the bigger model", !denyBigger.test(text));

    // The escalation banner survives reloads via the reply's meta.
    const doneEvt2 = events.find((e) => e.type === "done") as { messageId?: string } | undefined;
    if (doneEvt2?.messageId) {
      const saved = await db.message.findUnique({ where: { id: doneEvt2.messageId } });
      const notice = (saved?.meta as { notice?: string } | null)?.notice;
      check("escalation notice persisted in meta (survives reload)", notice === "Escalated to a more capable model.", String(notice));
    }

    // ── Phase 2: escalation must AUTO-REVERT — a trivial follow-up in the
    // same conversation goes back to the conversation model. The history
    // still contains the explicit "escalate" request, which must NOT be
    // treated as a standing instruction (steered: one-off per message).
    const t2 = new Date();
    const res2 = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id, content: "thanks! now just tell me in one short sentence: what day of the week is it?" }),
    });
    check("follow-up turn responds 200", res2.status === 200, `status ${res2.status}`);
    let full2 = ""; const reader2 = res2.body?.getReader();
    if (reader2) { while (true) { const { done, value } = await reader2.read(); if (done) break; full2 += dec.decode(value, { stream: true }); } }
    const events2 = [...full2.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; } });
    const text2 = events2.filter((e) => e.type === "text").map((e) => e.delta as string).join("");
    check("follow-up produced a reply", text2.trim().length > 0, `${text2.trim().length} chars`);

    const esc2 = await db.usageRecord.findMany({ where: { userId: user.id, role: "escalation", createdAt: { gte: t2 } } });
    const conv2 = await db.usageRecord.findMany({ where: { userId: user.id, role: "conversation", createdAt: { gte: t2 } } });
    check("follow-up did NOT re-escalate (back on the conversation model)", esc2.length === 0 && conv2.length > 0,
      `escalation calls=${esc2.length}, conversation calls=${conv2.length}`);
    const savedFollowup = await db.message.findFirst({
      where: { conversationId: convo.id, role: "assistant" }, orderBy: { createdAt: "desc" },
    });
    check("follow-up reply attributed to the conversation model", !!savedFollowup && !/opus/i.test(savedFollowup.model ?? ""),
      `model=${savedFollowup?.model}`);
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL ESCALATE-REQUEST CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
