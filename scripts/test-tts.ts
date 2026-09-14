/**
 * Live harness for reply TTS (the hover Listen button, 2026-07-13): the
 * /api/tts route must stream Kokoro's MP3 progressively — first audio bytes
 * within a couple of seconds, generation faster than playback — with strict
 * ownership. Requires the dev server + the kokoro container (heavy profile).
 *
 *  1. Seed a conversation with a markdown-heavy assistant reply (DB direct —
 *     no model call needed).
 *  2. GET /api/tts?messageId → 200 audio/mpeg; measure TTFB (first chunk) and
 *     total stream time; estimate audio duration from MP3 size and assert the
 *     full stack stays comfortably faster than realtime.
 *  3. Guards: unauth → 401, malformed id → 400, another user's message → 404,
 *     a USER-role message → 404.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-tts.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "tts-listen-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
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

const REPLY_MARKDOWN = `## Quick rundown

Here is what I found — the **key numbers** are worth hearing:

- The project runs at roughly two point seven times realtime on the CPU.
- Streaming starts almost immediately, then playback rides along behind it.
- See [the benchmark](https://example.com/bench) for the raw figures.

\`\`\`python
print("this code must never be read aloud")
\`\`\`

In short, the voice output should feel seamless: a moment of quiet, then
steady speech while the rest of the audio is still being generated in the
background. That is exactly the behaviour this harness is timing right now.`;

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `tts-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const other = await db.user.create({
    data: { email: `tts-other-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "TTS harness" } });
  const userRow = await db.message.create({
    data: { conversationId: convo.id, role: "user", content: "Read me the rundown." },
  });
  const reply = await db.message.create({
    data: { conversationId: convo.id, role: "assistant", content: REPLY_MARKDOWN },
  });

  try {
    const cookie = await login(user.email);
    const otherCookie = await login(other.email);

    // ---- the streaming path -------------------------------------------------
    const t0 = performance.now();
    const res = await fetch(`${BASE}/api/tts?messageId=${reply.id}`, { headers: { cookie: cookie() } });
    check("GET /api/tts → 200", res.status === 200, `status ${res.status}`);
    check("content-type audio/mpeg", res.headers.get("content-type") === "audio/mpeg", String(res.headers.get("content-type")));

    let ttfbMs = 0;
    let bytes = 0;
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          if (!ttfbMs) ttfbMs = performance.now() - t0;
          bytes += value.length;
        }
      }
    }
    const totalS = (performance.now() - t0) / 1000;
    // Kokoro's MP3 is 128 kbps → duration ≈ bytes*8/128000.
    const audioS = (bytes * 8) / 128_000;
    const rtf = audioS / totalS;
    check("first audio chunk within 3s", ttfbMs > 0 && ttfbMs < 3_000, `${Math.round(ttfbMs)}ms`);
    check("audio is substantial", bytes > 100_000, `${bytes} bytes ≈ ${audioS.toFixed(1)}s of speech`);
    check(
      "full stack faster than 1.5x realtime",
      rtf >= 1.5,
      `${audioS.toFixed(1)}s audio in ${totalS.toFixed(1)}s → ${rtf.toFixed(2)}x`,
    );
    // The stripper runs server-side; nothing to assert in audio — but the char
    // budget the route logged must exclude the fenced code. Sanity via length:
    // the code line is 40+ chars; strict proof lives in the unit tests.

    // ---- guards -------------------------------------------------------------
    // Middleware bounces unauthenticated requests to /login (307) before the
    // route's own 401 can fire — either status proves the gate.
    const noAuth = await fetch(`${BASE}/api/tts?messageId=${reply.id}`, { redirect: "manual" });
    check("unauthenticated → blocked (307/401)", noAuth.status === 307 || noAuth.status === 401, `status ${noAuth.status}`);
    const badId = await fetch(`${BASE}/api/tts?messageId=not-a-uuid`, { headers: { cookie: cookie() } });
    check("malformed id → 400", badId.status === 400, `status ${badId.status}`);
    const foreign = await fetch(`${BASE}/api/tts?messageId=${reply.id}`, { headers: { cookie: otherCookie() } });
    check("another user's message → 404", foreign.status === 404, `status ${foreign.status}`);
    const userMsg = await fetch(`${BASE}/api/tts?messageId=${userRow.id}`, { headers: { cookie: cookie() } });
    check("a user-role message → 404", userMsg.status === 404, `status ${userMsg.status}`);
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: other.id } }).catch(() => {});
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
