/**
 * Live harness for the sources + tool-status features: asks the assistant a
 * question that forces a web search through the REAL chat route, then checks
 * (1) live `tool` SSE status events with friendly labels, (2) `sources` SSE
 * events carrying url+title, (3) sources persisted on the saved message's
 * meta so the panel survives reloads.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-sources-status.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "sources-smoke-pw-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `sources-smoke-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => {
      for (const c of cs) {
        const p = c.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());
    check("logged in", r2.status === 302 || r2.status === 200, `status ${r2.status}`);

    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: null,
        content: "Search the web for the current BBC News top story and summarise it in one sentence.",
      }),
    });
    check("chat route responds 200", chatRes.status === 200, `status ${chatRes.status}`);

    const reader = chatRes.body?.getReader();
    const decoder = new TextDecoder();
    let full = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
      }
    }

    const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => {
      try {
        return JSON.parse(m[1]) as Record<string, unknown>;
      } catch {
        return {};
      }
    });

    const toolEvents = events.filter((e) => e.type === "tool");
    check(
      "live `tool` status events streamed",
      toolEvents.length > 0 && toolEvents.some((e) => /Searching|Reading/i.test(String(e.label))),
      JSON.stringify(toolEvents.map((e) => e.label)),
    );

    const sourceEvents = events.filter((e) => e.type === "sources");
    const streamedSources = sourceEvents.flatMap((e) => (e.sources as { url: string; title?: string }[]) ?? []);
    check(
      "`sources` SSE events carry urls",
      streamedSources.length > 0 && streamedSources.every((s) => /^https?:\/\//.test(s.url)),
      JSON.stringify(streamedSources.slice(0, 3)),
    );
    check("sources have titles", streamedSources.some((s) => !!s.title));

    const doneEvt = events.find((e) => e.type === "done") as { messageId?: string } | undefined;
    check("reply saved", !!doneEvt?.messageId);
    if (doneEvt?.messageId) {
      const saved = await db.message.findUnique({ where: { id: doneEvt.messageId } });
      const meta = saved?.meta as { sources?: { url: string }[] } | null;
      check(
        "sources persisted on message meta",
        Array.isArray(meta?.sources) && meta!.sources!.length > 0,
        JSON.stringify(meta?.sources?.slice(0, 2)),
      );
      check(
        "persisted sources match streamed (deduped)",
        (meta?.sources?.length ?? 0) <= streamedSources.length &&
          (meta?.sources ?? []).every((s) => streamedSources.some((t) => t.url === s.url)),
      );
    }

    check("no error events", !events.some((e) => e.type === "error"), JSON.stringify(events.find((e) => e.type === "error") ?? ""));
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
