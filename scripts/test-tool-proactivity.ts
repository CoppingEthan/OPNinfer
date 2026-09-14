/**
 * Live regression for tool PROACTIVITY (owner chat 40c8b7a3): asked "latest
 * news in the uk" then "actually in market deeping", the model replied
 * "Want me to go ahead and search?" instead of just searching — an extra
 * pointless round-trip. The MORE TOOLS directory now instructs the model to
 * enable + USE tools in the same turn, never ask permission for implied,
 * non-destructive work.
 *
 * Recreates the exact shape: sourced news reply in history (provenance note
 * included), then the location correction — the turn must SEARCH.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-tool-proactivity.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "proactive-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `proactive-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "uk news" } });
  await db.message.create({ data: { conversationId: convo.id, role: "user", content: "what is the latest news in the uk" } });
  await db.message.create({
    data: {
      conversationId: convo.id, role: "assistant", model: "claude-sonnet-5", provider: "anthropic-api",
      content: "Here's the biggest UK news right now: [a summary of national headlines — politics, weather, sport].",
      meta: { sources: [
        { url: "https://www.bbc.co.uk/news", title: "BBC News" },
        { url: "https://news.sky.com/uk", title: "Sky News UK" },
      ] },
    },
  });

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
      body: JSON.stringify({ conversationId: convo.id, content: "actually in market deeping" }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);
    let full = ""; const reader = res.body?.getReader(); const dec = new TextDecoder();
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); } }
    const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; } });

    const searched = events.some((e) => e.type === "tool" && /search/i.test(String(e.label ?? "")));
    const sources = events.some((e) => e.type === "sources");
    const text = events.filter((e) => e.type === "text").map((e) => e.delta as string).join("");
    // The failure mode is asking INSTEAD of acting ("Want me to go ahead and
    // search?" with no search). A follow-up offer AFTER doing the work is fine.
    const deflected =
      !searched && /\b(want me to|would you like me to|shall i|should i)\b/i.test(text);

    check("the turn actually SEARCHED (tool activity streamed)", searched);
    check("live sources streamed with the reply", sources);
    check("reply covers the town (not a deflection)", /market deeping|deeping/i.test(text), text.slice(0, 200));
    check("did not deflect with a permission question", !deflected, deflected ? text.slice(0, 250) : "");
    check("no error event", !events.some((e) => e.type === "error"));
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL TOOL-PROACTIVITY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
