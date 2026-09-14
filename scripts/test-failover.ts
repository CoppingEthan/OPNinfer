/**
 * Failover rig (checklist 1.6 — previously untestable from the UI). Proves
 * BOTH designed behaviours by temporarily rewiring the assistant config:
 *
 *  Phase A — TRANSIENT failure → failover: the conversation role points at an
 *    OpenAI credential whose baseUrl is unreachable (127.0.0.1:9 →
 *    ECONNREFUSED → retryable). The turn must switch to the failover role
 *    (the instance's real model), stream the notice + a real reply, and
 *    record usage under role=failover.
 *
 *  Phase B — CONFIG error (bad key, 401) → surfaced, NOT masked: same shape
 *    but a garbage key against the real endpoint. The turn must yield an
 *    HONEST error event with NO failover (silent switching would hide admin
 *    config bugs — by design).
 *
 * The original assistant_config is snapshotted and restored in `finally`.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-failover.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { encrypt } from "../src/lib/crypto";
import type { Prisma } from "@prisma/client";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "failover-1!";
const KEY = "assistant_config";

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
        /* ignore */
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

interface RoleConfig { credentialId: string; provider: string; model: string; reasoning?: string; reasoningExtended?: string }
interface AssistantCfg { name: string; logo?: string; roles: Record<string, RoleConfig | undefined> }

async function runTurn(cookie: () => string, content: string) {
  const state = {
    convId: null as string | null,
    text: "",
    notice: null as string | null,
    error: null as string | null,
    doneId: null as string | null,
  };
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) {
    state.error = `POST ${res.status}`;
    return state;
  }
  await readSse(res, (ev) => {
    if (ev.type === "meta") state.convId = ev.conversationId as string;
    else if (ev.type === "text") state.text += ev.delta as string;
    else if (ev.type === "notice") state.notice = String(ev.message);
    else if (ev.type === "error") state.error = String(ev.message);
    else if (ev.type === "done") state.doneId = (ev.messageId as string) ?? null;
  });
  return state;
}

async function main() {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (!row) throw new Error("no assistant_config configured — set up the assistant first");
  const originalValue = row.value as Prisma.InputJsonValue;
  const original = row.value as unknown as AssistantCfg;
  const realConversation = original.roles.conversation;
  if (!realConversation) throw new Error("no conversation role configured");

  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `failover-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const credIds: string[] = [];
  const convIds: string[] = [];

  const setConfig = async (conversation: RoleConfig) => {
    const cfg: AssistantCfg = {
      ...original,
      roles: { ...original.roles, conversation, failover: realConversation },
    };
    await db.setting.update({ where: { key: KEY }, data: { value: cfg as unknown as Prisma.InputJsonValue } });
  };

  try {
    const cookie = await login(user.email);

    // --- Phase A: unreachable endpoint (network error → failover) ------------
    const unreachable = await db.providerCredential.create({
      data: {
        provider: "openai",
        label: "failover-rig-unreachable (temp)",
        encryptedValue: new Uint8Array(encrypt("sk-junk-unreachable")),
        metadata: { baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    credIds.push(unreachable.id);
    await setConfig({ credentialId: unreachable.id, provider: "openai", model: "gpt-4o-mini" });

    const a = await runTurn(cookie, "Reply with the word FAILOVER-OK and one short sentence.");
    if (a.convId) convIds.push(a.convId);
    check("A: transient failure switched to the failover model (notice)", a.notice === "Switched to the failover model.", a.notice ?? a.error ?? "(nothing)");
    check("A: failover produced a real reply", !!a.doneId && a.text.length > 5 && !a.error, a.text.slice(0, 80) || a.error || "");
    const failoverUsage = await db.usageRecord.count({ where: { userId: user.id, role: "failover" } });
    check("A: usage recorded under role=failover", failoverUsage >= 1, `${failoverUsage} row(s)`);
    const warned = await db.appLog.findFirst({ where: { userId: user.id, category: "failover" }, orderBy: { createdAt: "desc" } });
    check("A: failover appLog entry written", !!warned, warned?.message ?? "");

    // --- Phase B: bad key (401 → honest error, NO failover) -------------------
    const badKey = await db.providerCredential.create({
      data: {
        provider: "openai",
        label: "failover-rig-badkey (temp)",
        encryptedValue: new Uint8Array(encrypt("sk-invalid-key-for-1-6-test")),
      },
    });
    credIds.push(badKey.id);
    await setConfig({ credentialId: badKey.id, provider: "openai", model: "gpt-4o-mini" });

    const b = await runTurn(cookie, "Reply with the word SHOULD-NOT-ARRIVE.");
    if (b.convId) convIds.push(b.convId);
    check("B: bad key surfaced as an honest error", !!b.error, b.error ?? "(no error event)");
    check("B: 4xx did NOT trigger failover (no notice, no reply)", !b.notice && !b.doneId && b.text.length === 0, b.notice ?? b.text.slice(0, 60) ?? "");
    const failoverUsageAfterB = await db.usageRecord.count({ where: { userId: user.id, role: "failover" } });
    check("B: no additional failover usage", failoverUsageAfterB === failoverUsage, `${failoverUsageAfterB} row(s)`);
  } finally {
    await db.setting.update({ where: { key: KEY }, data: { value: originalValue } }).catch((e) => {
      console.error("!! FAILED TO RESTORE assistant_config — restore manually in Admin → Models", e);
    });
    for (const id of convIds) await db.conversation.delete({ where: { id } }).catch(() => {});
    for (const id of credIds) await db.providerCredential.delete({ where: { id } }).catch(() => {});
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.appLog.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  // Sanity: config back to the real model.
  const after = (await db.setting.findUnique({ where: { key: KEY } }))?.value as unknown as AssistantCfg;
  check("assistant_config restored exactly", JSON.stringify(after) === JSON.stringify(original), after?.roles?.conversation?.model ?? "");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
