/**
 * Authenticated HTTP smoke for per-chat storage pools (NOT in the test suite).
 * Drives the running dev server through a real session: create-on-attach,
 * streamed upload, name dedupe, owner-only download, the mid-stream size cap,
 * and disk cleanup via the incognito wipe.
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
 *   node --env-file=.env --import tsx scripts/test-files-http.ts
 *
 * Two throwaway users are created and removed in a `finally`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "files-smoke-pw-4821!";
const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";

const poolDir = (convId: string) => join(STORAGE, TENANT, "chats", convId);

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

/** Minimal cookie-jar session per user. */
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

function fileForm(name: string, content: Buffer | string, type = "text/plain") {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type }));
  return fd;
}

async function main() {
  const cleanupUserIds: string[] = [];
  const cleanupConvIds: string[] = [];
  try {
    // -- setup: two throwaway users -------------------------------------
    const mk = async (tag: string) => {
      const u = await db.user.create({
        data: {
          email: `files-smoke-${tag}-${Date.now()}@example.test`,
          passwordHash: await hashPassword(PASSWORD),
          role: "user",
          emailVerified: new Date(),
        },
      });
      cleanupUserIds.push(u.id);
      return u;
    };
    const alice = await mk("a");
    const mallory = await mk("b");
    const sa = new Session();
    const sb = new Session();
    check("alice logs in", await sa.login(alice.email));
    check("mallory logs in", await sb.login(mallory.email));

    // -- 1. create-on-attach + pool layout --------------------------------
    const up1 = await sa.fetch(`/api/files?`, {
      method: "POST",
      body: fileForm("Quarterly Report 2026.txt", "hello pool"),
    });
    const d1 = (await up1.json()) as Record<string, unknown>;
    check("upload with no conversation → 200", up1.status === 200, JSON.stringify(d1).slice(0, 120));
    check("conversation created on attach", d1.conversationCreated === true);
    const convId = d1.conversationId as string;
    cleanupConvIds.push(convId);
    check("row starts pending for the worker", d1.status === "pending");
    check(
      "file lands in the chat pool under its real name",
      existsSync(join(poolDir(convId), "Quarterly Report 2026.txt")),
      poolDir(convId),
    );

    // -- 2. dedupe on collision -------------------------------------------
    const up2 = await sa.fetch(`/api/files?conversationId=${convId}`, {
      method: "POST",
      body: fileForm("Quarterly Report 2026.txt", "second copy"),
    });
    const d2 = (await up2.json()) as Record<string, unknown>;
    check(
      'same name dedupes to "… (2).txt"',
      d2.filename === "Quarterly Report 2026 (2).txt" &&
        existsSync(join(poolDir(convId), "Quarterly Report 2026 (2).txt")),
      String(d2.filename),
    );

    // -- 3. owner-only download --------------------------------------------
    const dl = await sa.fetch(`/api/files/${d1.id}`);
    const body = await dl.text();
    check("owner downloads (200 + bytes match)", dl.status === 200 && body === "hello pool");
    const dlOther = await sb.fetch(`/api/files/${d1.id}`);
    check("another signed-in user is blocked (404)", dlOther.status === 404, `status ${dlOther.status}`);
    const dlAnon = await fetch(`${BASE}/api/files/${d1.id}`, { redirect: "manual" });
    check(
      "anonymous request is blocked",
      dlAnon.status === 401 || dlAnon.status === 307,
      `status ${dlAnon.status}`,
    );

    // -- 4. size limit enforced mid-stream ---------------------------------
    await db.setting.upsert({
      where: { key: "max_upload_bytes" },
      create: { key: "max_upload_bytes", value: 1024 * 1024 },
      update: { value: 1024 * 1024 },
    });
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const up3 = await sa.fetch(`/api/files?conversationId=${convId}`, {
      method: "POST",
      body: fileForm("too-big.bin", big, "application/octet-stream"),
    });
    check("2 MB upload against a 1 MB limit → 413", up3.status === 413, `status ${up3.status}`);
    check(
      "partial oversized file removed from the pool",
      !existsSync(join(poolDir(convId), "too-big.bin")),
    );
    await db.setting.delete({ where: { key: "max_upload_bytes" } }).catch(() => {});

    // -- 5. wipe deletes the pool from disk (incognito route over HTTP) ----
    const upInc = await sa.fetch(`/api/files?incognito=1`, {
      method: "POST",
      body: fileForm("secret.txt", "ephemeral"),
    });
    const dInc = (await upInc.json()) as Record<string, unknown>;
    const incId = dInc.conversationId as string;
    check("incognito attach creates a pool", existsSync(join(poolDir(incId), "secret.txt")));
    const incRow = await db.conversation.findUnique({ where: { id: incId } });
    check("attach-created incognito chat is flagged", incRow?.incognito === true);
    const wipe = await sa.fetch(`/api/chat/incognito-cleanup`, {
      method: "POST",
      body: JSON.stringify({ id: incId }),
    });
    check("incognito wipe returns 204", wipe.status === 204);
    check("…and the pool directory is GONE from disk", !existsSync(poolDir(incId)));

    // -- 6. failed create-on-attach rolls the conversation back ------------
    await db.setting.upsert({
      where: { key: "max_upload_bytes" },
      create: { key: "max_upload_bytes", value: 1024 },
      update: { value: 1024 },
    });
    const before = await db.conversation.count({ where: { userId: alice.id } });
    const upFail = await sa.fetch(`/api/files?`, {
      method: "POST",
      body: fileForm("fail.bin", Buffer.alloc(64 * 1024, 1), "application/octet-stream"),
    });
    const after = await db.conversation.count({ where: { userId: alice.id } });
    check(
      "oversized first-attach → 413 AND no orphan conversation",
      upFail.status === 413 && after === before,
      `status ${upFail.status}, convos ${before}→${after}`,
    );
    await db.setting.delete({ where: { key: "max_upload_bytes" } }).catch(() => {});
  } finally {
    // Teardown: delete users (conversations/files cascade), then sweep pools.
    for (const id of cleanupConvIds) {
      const dir = poolDir(id);
      if (existsSync(dir)) {
        const { rmSync } = await import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      }
    }
    for (const id of cleanupUserIds) {
      await db.user.delete({ where: { id } }).catch(() => {});
    }
    await db.setting.delete({ where: { key: "max_upload_bytes" } }).catch(() => {});
    await db.$disconnect();
    console.log("\nCleaned up throwaway users, pools, and the test size limit.");
  }

  console.log(`\n${failures === 0 ? "ALL POOL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
