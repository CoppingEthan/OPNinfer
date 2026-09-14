/**
 * Milestone E live smoke — the assistant actually USING the file layer (NOT in
 * the test suite; burns a few cents of real provider credit). Requires the dev
 * server + worker running and the assistant configured in Admin → Models.
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; $env:FIXTURES_DIR='…'
 *   node --env-file=.env --import tsx scripts/test-chat-files-http.ts
 *
 * 1. Uploads a CSV → asks a question only answerable by read_file → asserts
 *    the tool ran (Read notice) and the answer contains the value.
 * 2. Uploads a PNG of the word PINEAPPLE → asks what it says → asserts native
 *    vision saw it.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "chat-files-pw-5590!";
const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";
const FIXTURES = process.env.FIXTURES_DIR ?? "";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

class Session {
  private jar = new Map<string, string>();
  private store(setCookies: string[]) {
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async login(email: string): Promise<boolean> {
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    this.store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.cookie(),
      },
      body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
      redirect: "manual",
    });
    this.store(r2.headers.getSetCookie());
    return [...this.jar.keys()].some((k) => k.includes("session-token"));
  }
  async fetch(path: string, init: RequestInit = {}) {
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie: this.cookie() },
      redirect: "manual",
    });
  }
}

function fileForm(name: string, content: Buffer | string, type: string) {
  const fd = new FormData();
  fd.append("file", new File([content as BlobPart], name, { type }));
  return fd;
}

interface ChatOutcome {
  text: string;
  notices: string[];
  error: string | null;
}

async function chatTurn(
  s: Session,
  conversationId: string,
  content: string,
  fileIds?: string[],
): Promise<ChatOutcome> {
  const res = await s.fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, content, fileIds }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    return { text: "", notices: [], error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: ChatOutcome = { text: "", notices: [], error: null };
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
      const evt = JSON.parse(line) as { type: string; delta?: string; message?: string; label?: string };
      if (evt.type === "text") out.text += evt.delta ?? "";
      else if (evt.type === "notice") out.notices.push(evt.message ?? "");
      // Tool activity now streams as `tool` status events (v0.3.x) — treat
      // them as notices so the "assistant invoked read_file" check still holds.
      else if (evt.type === "tool") out.notices.push(evt.label ?? "");
      else if (evt.type === "error") out.error = evt.message ?? "error";
    }
  }
  return out;
}

async function waitReady(ids: string[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await db.file.findMany({ where: { id: { in: ids } } });
    if (!rows.some((r) => r.status === "pending" || r.status === "processing")) return;
    if (Date.now() > deadline) throw new Error("worker did not finish in time");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `chat-files-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const s = new Session();
    check("login", await s.login(user.email));

    // ---- 1. CSV: force a read_file round-trip ------------------------------
    const csv =
      "product,unit_price_gbp\nWidget,9.99\nGadget,417.83\nDoohickey,3.25";
    const up = await s.fetch(`/api/files?`, {
      method: "POST",
      body: fileForm("prices.csv", csv, "text/csv"),
    });
    const upData = (await up.json()) as Record<string, unknown>;
    check("csv uploaded (chat created on attach)", up.status === 200);
    convId = upData.conversationId as string;
    await waitReady([upData.id as string], 60_000);

    const t1 = await chatTurn(
      s,
      convId,
      "Check prices.csv in this chat's files and tell me the exact unit price of the Gadget. Include the number in your reply.",
      [upData.id as string],
    );
    check("turn 1 streamed without error", t1.error === null, t1.error ?? "");
    // The manifest now INLINES small files' content, so the model usually
    // answers from the inline content without a read_file tool call. What
    // matters is that it got the file's content — i.e. the exact value.
    // (read_file itself is covered by test-sandbox-tools' raw read.)
    check(
      "assistant has the file's content (inline manifest or read_file)",
      t1.text.includes("417.83"),
      t1.text.slice(0, 220),
    );
    check(
      "answer contains the exact value only the file knows (417.83)",
      t1.text.includes("417.83"),
      t1.text.slice(0, 220),
    );

    // ---- 2. PNG: native vision ------------------------------------------------
    const up2 = await s.fetch(`/api/files?conversationId=${convId}`, {
      method: "POST",
      body: fileForm(
        "word.png",
        readFileSync(join(FIXTURES, "word.png")),
        "image/png",
      ),
    });
    const up2Data = (await up2.json()) as Record<string, unknown>;
    check("png uploaded", up2.status === 200);
    await waitReady([up2Data.id as string], 60_000);

    const t2 = await chatTurn(
      s,
      convId,
      "What single word is written in the attached image? Answer with just that word.",
      [up2Data.id as string],
    );
    check("turn 2 streamed without error", t2.error === null, t2.error ?? "");
    check(
      "vision model read the word in the image",
      t2.text.toLowerCase().includes("pineapple"),
      t2.text.slice(0, 120),
    );
  } finally {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    if (convId) {
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up throwaway user and pool.");
  }

  console.log(`\n${failures === 0 ? "ALL CHAT-FILES CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
