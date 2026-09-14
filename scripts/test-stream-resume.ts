/**
 * Live harness for RESUMABLE turn streams. Drives the real HTTP API:
 *
 *  1. Start a turn (POST /api/chat), read a couple of text deltas, then DROP
 *     the connection — the owner leaving the page mid-reply.
 *  2. GET /api/chat/stream → must re-attach: replay the missed prefix, then
 *     follow live to `done`. The concatenated text must EXACTLY equal the
 *     saved DB reply (generation was never interrupted by the disconnect).
 *  3. A second resume within the grace window replays the FINISHED turn.
 *  4. An idle conversation → 204 (nothing to resume).
 *  5. While a turn runs: a duplicate POST on the same conversation → 409;
 *     another user's resume → 204 and their stop → 404 (ownership);
 *     POST /api/chat/stop → {stopped:true}, the stream ends promptly, and the
 *     partial reply is SAVED.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-stream-resume.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "resume-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

interface SseEvent { type: string; [k: string]: unknown }

/** Read an SSE body, invoking onEvent per event; resolves when the stream ends. */
async function readSse(
  res: Response,
  onEvent: (ev: SseEvent) => void | "stop",
): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.startsWith("data:") ? frame.slice(5).trim() : "";
      if (!line) continue;
      if (onEvent(JSON.parse(line) as SseEvent) === "stop") {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

async function login(email: string) {
  const jar = new Map<string, string>();
  const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
  const { csrfToken } = await r1.json() as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email, password: PASSWORD }), redirect: "manual" });
  store(r2.headers.getSetCookie());
  return cookie;
}

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `resume-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const other = await db.user.create({
    data: { email: `resume-other-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const convIds: string[] = [];
  try {
    const cookie = await login(user.email);
    const otherCookie = await login(other.email);

    // ---- 1+2: drop mid-stream, resume, full reply intact -------------------
    let convId: string | null = null;
    let seenBeforeDrop = "";
    let textEvents = 0;
    const post = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ content: "Write the numbers 1 to 30, one per line, each followed by a different three-word phrase. No preamble." }),
    });
    check("POST /api/chat streams", post.ok && !!post.body, String(post.status));
    await readSse(post, (ev) => {
      if (ev.type === "meta") convId = ev.conversationId as string;
      if (ev.type === "text") {
        seenBeforeDrop += ev.delta as string;
        textEvents++;
        if (textEvents >= 2) return "stop"; // user leaves the page mid-reply
      }
    });
    check("dropped the connection mid-reply", !!convId && textEvents >= 2, `saw ${seenBeforeDrop.length} chars`);
    if (convId) convIds.push(convId);

    // The generation must still be running server-side — resume it.
    const resume = await fetch(`${BASE}/api/chat/stream?conversationId=${convId}`, {
      headers: { cookie: cookie() },
    });
    check("GET /api/chat/stream re-attaches (200 SSE)", resume.status === 200, `status ${resume.status}`);
    let resumedText = "";
    let doneId: string | null = null;
    let sawError: string | null = null;
    await readSse(resume, (ev) => {
      if (ev.type === "text") resumedText += ev.delta as string;
      if (ev.type === "done") doneId = (ev.messageId as string) ?? null;
      if (ev.type === "error") sawError = ev.message as string;
    });
    check("resume replayed the missed prefix", resumedText.startsWith(seenBeforeDrop), resumedText.slice(0, 60));
    check("resume ran to done with a saved messageId", !!doneId, String(doneId));
    check("no error events in the resumed stream", !sawError, sawError ?? "");
    check("reply is complete (reached 30)", /30/.test(resumedText));

    const savedRow = doneId ? await db.message.findUnique({ where: { id: doneId } }) : null;
    check("DB reply EXACTLY equals the resumed text", savedRow?.content === resumedText, `db ${savedRow?.content.length} vs stream ${resumedText.length} chars`);

    // ---- 3: a second resume within the grace window replays the whole turn -
    const late = await fetch(`${BASE}/api/chat/stream?conversationId=${convId}`, {
      headers: { cookie: cookie() },
    });
    check("post-completion resume (grace window) still 200", late.status === 200, `status ${late.status}`);
    let lateText = "";
    let lateDone = false;
    await readSse(late, (ev) => {
      if (ev.type === "text") lateText += ev.delta as string;
      if (ev.type === "done") lateDone = true;
    });
    check("grace replay delivers the full reply + done", lateDone && lateText === resumedText);

    // ---- 4: idle conversation → 204 ----------------------------------------
    const idle = await db.conversation.create({ data: { userId: user.id, title: "idle" } });
    convIds.push(idle.id);
    const noTurn = await fetch(`${BASE}/api/chat/stream?conversationId=${idle.id}`, {
      headers: { cookie: cookie() },
    });
    check("idle conversation → 204 (nothing to resume)", noTurn.status === 204, `status ${noTurn.status}`);

    // ---- 5: concurrent-POST 409, ownership, stop ----------------------------
    let conv2: string | null = null;
    let stopIssued = false;
    let stoppedOk = false;
    let dup409 = false;
    let otherResume204 = false;
    let otherStop404 = false;
    let done2: string | null = null;
    const t0 = Date.now();
    const post2 = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ content: "Write the numbers 1 to 200, one per line. No other text." }),
    });
    await readSse(post2, (ev) => {
      if (ev.type === "meta") conv2 = ev.conversationId as string;
      if (ev.type === "done") done2 = (ev.messageId as string) ?? null;
      if (ev.type === "text" && !stopIssued && conv2) {
        stopIssued = true;
        // Mid-run, from OUTSIDE the stream: duplicate POST, foreign access, stop.
        void (async () => {
          const dup = await fetch(`${BASE}/api/chat`, {
            method: "POST",
            headers: { cookie: cookie(), "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv2, content: "second turn while first is running" }),
          });
          dup409 = dup.status === 409;
          const fr = await fetch(`${BASE}/api/chat/stream?conversationId=${conv2}`, { headers: { cookie: otherCookie() } });
          otherResume204 = fr.status === 204;
          const fs = await fetch(`${BASE}/api/chat/stop`, {
            method: "POST",
            headers: { cookie: otherCookie(), "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv2 }),
          });
          otherStop404 = fs.status === 404;
          const stop = await fetch(`${BASE}/api/chat/stop`, {
            method: "POST",
            headers: { cookie: cookie(), "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv2 }),
          });
          stoppedOk = stop.ok && (await stop.json() as { stopped: boolean }).stopped === true;
        })();
      }
    });
    const elapsed = Date.now() - t0;
    if (conv2) convIds.push(conv2);
    check("duplicate POST while running → 409", dup409);
    check("another user's resume → 204 (no leak)", otherResume204);
    check("another user's stop → 404 (ownership)", otherStop404);
    check("owner's stop → {stopped:true}", stoppedOk);
    check("stopped stream ended promptly (not the full 200 numbers)", elapsed < 30_000, `${elapsed}ms`);
    const partial = done2 ? await db.message.findUnique({ where: { id: done2 } }) : null;
    check("partial reply was SAVED on stop", !!partial && partial.content.length > 0, `${partial?.content.length ?? 0} chars`);
  } finally {
    for (const id of convIds) await db.conversation.delete({ where: { id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: other.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL STREAM-RESUME CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
