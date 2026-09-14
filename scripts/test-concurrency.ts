/**
 * Concurrency harness (checklist 15.3): THREE users stream chats at the same
 * time through the real HTTP API — no cross-talk allowed.
 *
 *  - all three POST /api/chat streams run simultaneously (overlap asserted)
 *  - each reply contains ITS OWN codeword and neither of the other two
 *  - each reply is saved to the right user's conversation
 *  - usage rows attribute to the right users
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-concurrency.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "concurrency-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

interface SseEvent { type: string; [k: string]: unknown }

async function readSse(res: Response, onEvent: (ev: SseEvent) => void): Promise<void> {
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
      try {
        onEvent(JSON.parse(line) as SseEvent);
      } catch {
        /* ignore malformed frames */
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

const CODES = ["XYLOPHONE-17", "MARMALADE-42", "PERISCOPE-99"];

interface Lane {
  userId: string;
  email: string;
  code: string;
  cookie: () => string;
  convId: string | null;
  text: string;
  doneId: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number;
}

async function main() {
  const stamp = Date.now();
  const lanes: Lane[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const email = `conc-${i}-${stamp}@example.test`;
      const user = await db.user.create({
        data: { email, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
      });
      lanes.push({
        userId: user.id,
        email,
        code: CODES[i],
        cookie: await login(email),
        convId: null,
        text: "",
        doneId: null,
        error: null,
        startedAt: 0,
        endedAt: 0,
      });
    }

    // Fire all three turns SIMULTANEOUSLY.
    await Promise.all(
      lanes.map(async (lane) => {
        lane.startedAt = Date.now();
        const res = await fetch(`${BASE}/api/chat`, {
          method: "POST",
          headers: { cookie: lane.cookie(), "content-type": "application/json" },
          body: JSON.stringify({
            content: `Count from 1 to 12, one number per line, then finish with a single sentence containing the codeword ${lane.code} exactly once. Do not mention any other codeword.`,
          }),
        });
        if (!res.ok || !res.body) {
          lane.error = `POST ${res.status}`;
          lane.endedAt = Date.now();
          return;
        }
        await readSse(res, (ev) => {
          if (ev.type === "meta") lane.convId = ev.conversationId as string;
          else if (ev.type === "text") lane.text += ev.delta as string;
          else if (ev.type === "done") lane.doneId = (ev.messageId as string) ?? null;
          else if (ev.type === "error") lane.error = String(ev.message);
        });
        lane.endedAt = Date.now();
      }),
    );

    check("all three streams completed with a reply", lanes.every((l) => l.doneId && l.text.length > 10 && !l.error), lanes.map((l) => `${l.code}: ${l.error ?? `${l.text.length} chars`}`).join(" · "));
    const overlapStart = Math.max(...lanes.map((l) => l.startedAt));
    const overlapEnd = Math.min(...lanes.map((l) => l.endedAt));
    check("streams genuinely overlapped in time", overlapEnd > overlapStart, `${overlapEnd - overlapStart}ms of three-way overlap`);

    for (const lane of lanes) {
      const others = lanes.filter((l) => l !== lane).map((l) => l.code);
      check(
        `${lane.code}: reply carries its own codeword and no other`,
        lane.text.includes(lane.code) && others.every((c) => !lane.text.includes(c)),
        lane.text.slice(-90),
      );
    }

    // Persistence: each reply saved in the RIGHT user's conversation.
    for (const lane of lanes) {
      const msg = lane.doneId ? await db.message.findUnique({ where: { id: lane.doneId }, include: { conversation: true } }) : null;
      check(
        `${lane.code}: saved to its own user's conversation`,
        !!msg && msg.conversationId === lane.convId && msg.conversation.userId === lane.userId && msg.content.includes(lane.code),
        msg ? `conv ${msg.conversationId?.slice(0, 8)}` : "missing",
      );
    }

    // Usage attribution: every lane's user has conversation-role usage.
    for (const lane of lanes) {
      const usage = await db.usageRecord.count({ where: { userId: lane.userId, role: "conversation" } });
      check(`${lane.code}: usage attributed to its user`, usage >= 1, `${usage} row(s)`);
    }
  } finally {
    for (const lane of lanes) {
      if (lane.convId) await db.conversation.delete({ where: { id: lane.convId } }).catch(() => {});
      await db.usageRecord.deleteMany({ where: { userId: lane.userId } }).catch(() => {});
      await db.appLog.deleteMany({ where: { userId: lane.userId } }).catch(() => {});
      await db.user.delete({ where: { id: lane.userId } }).catch(() => {});
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
