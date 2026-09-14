/**
 * Visualisation live smoke (NOT in the test suite; one real model turn via
 * the actual chat route). Asks for a simple SVG bar chart and asserts:
 * viz_start/viz/viz_end SSE events, no marker leakage into text, and
 * meta.viz persisted on the saved message.
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-viz-http.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "viz-smoke-pw-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `viz-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;

    // login
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
    check("login", [...jar.keys()].some((k) => k.includes("session-token")));

    // one real turn asking for a visual
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie() },
      body: JSON.stringify({
        conversationId: null,
        content:
          "Draw a simple SVG bar chart of these values, rendered inline in the chat: apples 4, pears 7, plums 2. Then give a one-line takeaway.",
      }),
    });
    check("chat turn accepted", res.ok && !!res.body, `status ${res.status}`);
    if (!res.ok || !res.body) throw new Error("no stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let viz = "";
    let starts = 0;
    let ends = 0;
    let vizTitle = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.startsWith("data:") ? frame.slice(5).trim() : "";
        if (!line) continue;
        const evt = JSON.parse(line) as Record<string, string>;
        if (evt.type === "text") text += evt.delta ?? "";
        else if (evt.type === "viz") viz += evt.delta ?? "";
        else if (evt.type === "viz_start") {
          starts++;
          vizTitle = evt.title ?? "";
        } else if (evt.type === "viz_end") ends++;
        else if (evt.type === "meta") convId = evt.conversationId ?? "";
        else if (evt.type === "error") throw new Error(evt.message);
      }
    }

    check("viz_start + viz_end SSE events", starts >= 1 && ends >= 1, `starts=${starts} ends=${ends}`);
    check("viz stream carries SVG", viz.includes("<svg"), viz.slice(0, 100));
    check("viz title from the tool call", vizTitle.length > 0, vizTitle);
    check("NO marker leakage into visible text", !text.includes("@@@VIZ"), text.slice(0, 120));
    check("chat text still has prose (takeaway)", text.trim().length > 10, text.trim().slice(0, 120));

    // persistence
    const saved = await db.message.findFirst({
      where: { conversationId: convId, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    const meta = saved?.meta as { viz?: { title: string; html: string }[] } | null;
    check(
      "meta.viz persisted with the html",
      !!meta?.viz?.length && meta.viz[0].html.includes("<svg"),
      `${meta?.viz?.length ?? 0} block(s)`,
    );
    check("saved content excludes markers", !!saved && !saved.content.includes("@@@VIZ"));
  } finally {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
    console.log("\nCleaned up throwaway user.");
  }

  console.log(`\n${failures === 0 ? "ALL VIZ CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
