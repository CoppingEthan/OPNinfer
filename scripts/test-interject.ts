/**
 * Live test for MID-TURN INTERJECTION: a message typed while the assistant is
 * mid tool-loop is spliced into the RUNNING turn between rounds (not queued
 * behind the wrong answer). The harness starts a slow two-step sandbox task,
 * interjects an extra instruction while step one is executing, and asserts
 * the same turn's final reply honors it — plus persistence order and the
 * closed-mailbox fallback contract.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-interject.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "interject-1!";
const MAGIC = "PINEAPPLE-42";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `interject-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "interject" } });

  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const interject = async (content: string) => {
      const res = await fetch(`${BASE}/api/chat/interject`, {
        method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convo.id, content }),
      });
      return (await res.json()) as { accepted?: boolean };
    };

    // No turn running yet → the offer must be refused (client would queue).
    const early = await interject("too early");
    check("offer refused when nothing is streaming", early.accepted === false);

    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: convo.id,
        content:
          "Use the sandbox to run the shell command `sleep 6 && echo step-one-done`. After it returns, run `sleep 6 && echo step-two-done` as a second, separate command — strictly one command per step, never both at once. Then report both outputs briefly.",
      }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);

    // Read the SSE incrementally; the moment the first tool actually RUNS,
    // interject the extra instruction (the turn is mid-loop right then).
    const timeline: { t: number; e: Record<string, unknown> }[] = [];
    let interjectSent = false;
    let interjectAccepted: boolean | undefined;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const m = frame.match(/^data: (.+)$/m);
        if (!m) continue;
        try { timeline.push({ t: Date.now(), e: JSON.parse(m[1]) }); } catch { continue; }
        const evt = timeline[timeline.length - 1].e;
        if (!interjectSent && evt.type === "tool" && /running|command|script/i.test(String(evt.label ?? ""))) {
          interjectSent = true;
          void interject(`One more thing: end your final reply with the exact word ${MAGIC}.`).then((r) => {
            interjectAccepted = r.accepted;
          });
        }
      }
    }

    const interjectedEvt = timeline.find((x) => x.e.type === "interjected");
    const firstText = timeline.find((x) => x.e.type === "text");
    const text = timeline.filter((x) => x.e.type === "text").map((x) => x.e.delta as string).join("");
    const doneEvt = timeline.find((x) => x.e.type === "done") as { e: { messageId?: string } } | undefined;

    check("tool activity seen (task really ran)", interjectSent);
    check("mid-turn offer was accepted", interjectAccepted === true, `accepted=${interjectAccepted}`);
    check("`interjected` SSE event streamed (bubble moves above the reply)", !!interjectedEvt, JSON.stringify(interjectedEvt?.e ?? {}));
    check("interjection landed BEFORE the final text", !!interjectedEvt && !!firstText && interjectedEvt.t <= firstText.t,
      interjectedEvt && firstText ? `interjected +${firstText.t - interjectedEvt.t}ms before text` : "");
    check(`same turn's reply honors it (ends with ${MAGIC})`, text.includes(MAGIC), text.slice(-160));
    check("no error event", !timeline.some((x) => x.e.type === "error"));

    // Persistence: [user, user(interjection), assistant] in that order.
    const rows = await db.message.findMany({ where: { conversationId: convo.id }, orderBy: { createdAt: "asc" } });
    const roles = rows.map((r) => r.role);
    check("transcript order is user → interjection → reply", roles.join(",") === "user,user,assistant", roles.join(","));
    check("interjection persisted as a real user message", rows[1]?.content.includes(MAGIC) === true);
    check("reply persisted", !!doneEvt?.e.messageId && rows[2]?.id === doneEvt.e.messageId);

    // Turn over → the mailbox is closed again.
    const late = await interject("too late");
    check("offer refused after the turn ends", late.accepted === false);
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL INTERJECT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
