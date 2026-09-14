/**
 * Live regression for the send-while-processing UX: a user may hit send while
 * attachments are still ingesting (voice notes transcribe asynchronously).
 * The chat route must HOLD the turn — streaming a "Processing …" status line
 * — and only run the model once ingestion finishes, so the reply actually
 * contains the attachment's content.
 *
 * Deterministic: the seeded file is frozen at status=processing (the worker
 * only claims `pending`, and only reclaims `processing` when claimed_at goes
 * stale), then flipped to ready — with a magic token in the prepared artifact
 * — 4 seconds after the send. If the model's reply quotes the token, the
 * manifest was provably built AFTER the wait.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-ingest-wait.ts
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolRelDir, resolveStoredPath } from "../src/lib/storage";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "ingest-wait-1!";
const MAGIC = "AUBERGINE-73";
const FLIP_AFTER_MS = 4_000;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `ingest-wait-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "ingest wait" } });
  const rel = chatPoolRelDir(convo.id);
  const poolAbs = resolveStoredPath(rel);

  // A file mid-ingestion: processing + fresh claimed_at → the worker leaves it alone.
  const file = await db.file.create({
    data: {
      userId: user.id, conversationId: convo.id, filename: "voice-note.txt",
      mimeType: "text/plain", detectedMime: "text/plain", sizeBytes: BigInt(64),
      storagePath: `${rel}/voice-note.txt`, kind: "upload",
      status: "processing", claimedAt: new Date(), attempts: 1,
    },
  });
  await mkdir(`${poolAbs}/.opninfer`, { recursive: true });
  await writeFile(`${poolAbs}/voice-note.txt`, `The secret code word is ${MAGIC}.`, "utf8");

  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    // Flip to ready mid-request — the "worker finished" moment.
    let flippedAt = 0;
    const flip = (async () => {
      await new Promise((r) => setTimeout(r, FLIP_AFTER_MS));
      await writeFile(`${poolAbs}/.opninfer/${file.id}.md`, `Transcript of voice-note: "The secret code word is ${MAGIC}."`, "utf8");
      await db.file.update({
        where: { id: file.id },
        data: { status: "ready", contentPath: `${rel}/.opninfer/${file.id}.md`, tokenEstimate: 20, claimedAt: null },
      });
      flippedAt = Date.now();
    })();

    const sentAt = Date.now();
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id, content: "What exactly does the attached voice note say? Quote the code word.", fileIds: [file.id] }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);

    // Read the SSE with per-event arrival times.
    const timeline: { t: number; e: Record<string, unknown> }[] = [];
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
        if (m) { try { timeline.push({ t: Date.now(), e: JSON.parse(m[1]) }); } catch { /* skip */ } }
      }
    }
    await flip;

    const procEvt = timeline.find((x) => x.e.type === "phase" && String(x.e.label ?? "").startsWith("Processing"));
    const phaseClear = timeline.find((x) => x.e.type === "phase" && x.e.label == null);
    const firstText = timeline.find((x) => x.e.type === "text");
    const text = timeline.filter((x) => x.e.type === "text").map((x) => x.e.delta as string).join("");
    const doneEvt = timeline.find((x) => x.e.type === "done") as { e: { messageId?: string } } | undefined;

    check("streams a 'Processing …' phase (shown in the thinking indicator)", !!procEvt, String(procEvt?.e.label));
    check("phase arrives BEFORE any reply text", !!procEvt && !!firstText && procEvt.t < firstText.t);
    check("phase CLEARS once processing finishes (gerund shimmer resumes)",
      !!procEvt && !!phaseClear && !!firstText && phaseClear.t > procEvt.t && phaseClear.t <= firstText.t);
    check("model start was HELD until the file was ready", !!firstText && flippedAt > 0 && firstText.t >= flippedAt,
      `first text +${firstText ? firstText.t - sentAt : "?"}ms, flip +${flippedAt - sentAt}ms`);
    check("reply quotes the transcript's code word (content seen)", text.includes(MAGIC), text.slice(0, 200));
    check("reply persisted", !!doneEvt?.e.messageId);
    check("no error event", !timeline.some((x) => x.e.type === "error"));
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await rm(poolAbs, { recursive: true, force: true }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL INGEST-WAIT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
