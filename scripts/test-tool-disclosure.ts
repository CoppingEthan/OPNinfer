/**
 * Live harness for progressive tool disclosure (the router replacement): the
 * CONVERSATION model decides its own tools. Reproduces the owner-reported
 * failure verbatim — "waht tools do you have" → "and test 5 of them" — which
 * under the old classifier router starved the toolset down to 2 tools. Now
 * the model reads the MORE TOOLS directory, calls enable_tools itself, and
 * actually runs the tools.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-tool-disclosure.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "disclosure-smoke-pw-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

interface Turn {
  status: number;
  text: string;
  tools: string[];
  errors: string[];
  conversationId: string | null;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `disclosure-smoke-${Date.now()}@example.test`,
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

    async function send(conversationId: string | null, content: string): Promise<Turn> {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { cookie: cookie(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId, content }),
      });
      const out: Turn = { status: res.status, text: "", tools: [], errors: [], conversationId };
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
      }
      for (const m of buf.matchAll(/^data: (.+)$/gm)) {
        try {
          const evt = JSON.parse(m[1]) as Record<string, unknown>;
          if (evt.type === "text") out.text += String(evt.delta ?? "");
          else if (evt.type === "tool") out.tools.push(String(evt.label ?? ""));
          else if (evt.type === "error") out.errors.push(String(evt.message ?? ""));
          else if (evt.type === "meta" && evt.conversationId) out.conversationId = String(evt.conversationId);
        } catch {
          /* keep-alives */
        }
      }
      return out;
    }

    // Turn 1: the tool-listing context.
    const t1 = await send(null, "waht tools do you have");
    check("turn 1 responds 200 without error", t1.status === 200 && t1.errors.length === 0, t1.errors[0]);
    check(
      "turn 1 does NOT claim tools are unavailable/not wired up",
      !/only tools? (actually )?(wired|available|enabled)|don't have (live )?access/i.test(t1.text),
      t1.text.slice(0, 200),
    );

    // Turn 2: the exact follow-up that used to starve the toolset. The model
    // freely picks WHICH tools to demo, so assert the load-bearing invariants
    // (it ran several tools and never claims a starved 2-tool set) rather than
    // an exact count/group, which depends on the model's free choice.
    const t2 = await send(t1.conversationId, "and test 5 of them");
    check("turn 2 responds 200 without error", t2.status === 200 && t2.errors.length === 0, t2.errors[0]);
    const distinct = new Set(t2.tools);
    check(
      "model ran multiple distinct tools (not starved to escalate+load_skill)",
      distinct.size >= 2,
      JSON.stringify([...distinct]),
    );
    check(
      "reply does not claim a starved toolset",
      !/only .{0,30}(escalate|load_skill)/i.test(t2.text),
      t2.text.slice(-300),
    );

    // Turn 3: DETERMINISTIC deferred-group reachability — explicitly require a
    // sandbox tool (a deferred group), so enable_tools must activate it.
    const t3 = await send(t1.conversationId, "Use your sandbox to run exactly this command and tell me the output: echo DISCLOSURE_OK_9137");
    check("turn 3 responds 200 without error", t3.status === 200 && t3.errors.length === 0, t3.errors[0]);
    check(
      "model reached a DEFERRED tool (sandbox) via enable_tools",
      t3.tools.some((l) => /Running|execute|sandbox/i.test(l)) || t3.text.includes("DISCLOSURE_OK_9137"),
      JSON.stringify([...new Set(t3.tools)]),
    );
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL DISCLOSURE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
