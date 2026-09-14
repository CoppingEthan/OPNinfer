/**
 * Live harness for PERSISTENT follow-up suggestions (owner bug, 2026-07-13):
 * navigating away and back used to lose generated suggestions (the chat
 * window remounts per conversation; state + idle timer died with it).
 *
 *  1. Conversation whose final reply is 6 minutes old ("should have
 *     generated while away") → POST /api/followups generates, PERSISTS on the
 *     reply's meta.followups, and bills exactly ONE frontend usage row.
 *  2. A second POST returns the SAME suggestions with NO new usage row
 *     (served from meta — idempotent).
 *  3. GET /chat/[id] HTML contains the restored suggestions (loader →
 *     initialFollowups → rendered on load, before any client timer).
 *  4. A new user turn makes the stored set stale: the route no longer serves
 *     it (newest message isn't an assistant reply → fresh generation,
 *     nothing persisted onto the old reply's carrier slot).
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-followups-persist.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "followups-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
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

const frontendUsageCount = (userId: string) =>
  db.usageRecord.count({ where: { userId, role: "frontend" } });

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `followups-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "Follow-ups harness" } });
  const sixMinAgo = new Date(Date.now() - 6 * 60_000);
  await db.message.create({
    data: { conversationId: convo.id, role: "user", content: "Give me three tips for tomato growing.", createdAt: new Date(sixMinAgo.getTime() - 30_000) },
  });
  const reply = await db.message.create({
    data: {
      conversationId: convo.id,
      role: "assistant",
      content: "1) Water deeply but infrequently. 2) Stake early. 3) Pinch out side shoots for larger fruit.",
      createdAt: sixMinAgo,
    },
  });

  try {
    const cookie = await login(user.email);

    // ---- 1. generate + persist + bill once ---------------------------------
    const gen = await fetch(`${BASE}/api/followups`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id }),
    });
    const first = (await gen.json()) as { suggestions?: string[] };
    check("followups generated", gen.ok && (first.suggestions?.length ?? 0) > 0, first.suggestions?.[0] ?? "");
    const replyAfter = await db.message.findUnique({ where: { id: reply.id } });
    const persisted = (replyAfter?.meta as { followups?: string[] } | null)?.followups ?? [];
    check("persisted on the reply's meta.followups", persisted.length > 0 && persisted[0] === first.suggestions![0]);
    const usage1 = await frontendUsageCount(user.id);
    check("exactly one frontend usage row", usage1 === 1, `got ${usage1}`);

    // ---- 2. idempotent re-fetch ---------------------------------------------
    const again = await fetch(`${BASE}/api/followups`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id }),
    });
    const second = (await again.json()) as { suggestions?: string[] };
    check("second call returns the same suggestions", JSON.stringify(second.suggestions) === JSON.stringify(first.suggestions));
    const usage2 = await frontendUsageCount(user.id);
    check("no new usage row (served from meta)", usage2 === usage1, `got ${usage2}`);

    // ---- 3. restored into the page on load ----------------------------------
    const page = await fetch(`${BASE}/chat/${convo.id}`, { headers: { cookie: cookie() } });
    const html = await page.text();
    const strip = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const probe = strip(first.suggestions![0]).slice(0, 24);
    check("chat page HTML contains the restored suggestions", page.ok && strip(html).includes(probe), `probe "${probe}"`);
    check("page shows the Suggested follow-ups header", /Suggested follow-ups/i.test(html));

    // ---- 4. a new user turn makes the stored set stale ----------------------
    await db.message.create({
      data: { conversationId: convo.id, role: "user", content: "What about peppers instead?" },
    });
    const stale = await fetch(`${BASE}/api/followups`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id }),
    });
    const third = (await stale.json()) as { suggestions?: string[] };
    check(
      "after a new user turn the stored set is NOT replayed",
      JSON.stringify(third.suggestions) !== JSON.stringify(first.suggestions),
      third.suggestions?.[0] ?? "",
    );
    const pageAfter = await fetch(`${BASE}/chat/${convo.id}`, { headers: { cookie: cookie() } });
    const htmlAfter = await pageAfter.text();
    check("stale suggestions not restored on load either", !/Suggested follow-ups/i.test(htmlAfter));
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
