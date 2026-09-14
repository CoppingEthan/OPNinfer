/**
 * Milestone D smoke — heavy engines (NOT in the test suite). Requires the dev
 * server + the FULL heavy profile running:
 *
 *   docker compose -f docker-compose.dev.yml --profile heavy up -d
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; $env:FIXTURES_DIR='…'
 *   node --env-file=.env --import tsx scripts/test-ingestion-d-http.ts
 *
 * Covers: scanned PDF → MarkItDown thin-text escalation → Docling OCR, and
 * WAV speech → Whisper transcript. First run is slow (model downloads).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "ingest-d-pw-9002!";
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

function fileForm(name: string, content: Buffer, type: string) {
  const fd = new FormData();
  fd.append("file", new File([content as BlobPart], name, { type }));
  return fd;
}

async function main() {
  for (const f of ["scanned.pdf", "speech.wav"]) {
    if (!existsSync(join(FIXTURES, f))) throw new Error(`Missing fixture ${f}`);
  }
  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `ingest-d-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const s = new Session();
    check("login", await s.login(user.email));

    const ids: Record<string, string> = {};
    for (const u of [
      { label: "scanned", name: "scanned.pdf", type: "application/pdf" },
      { label: "speech", name: "speech.wav", type: "audio/wav" },
    ]) {
      const params = convId ? `conversationId=${convId}` : "";
      const res = await s.fetch(`/api/files?${params}`, {
        method: "POST",
        body: fileForm(u.name, readFileSync(join(FIXTURES, u.name)), u.type),
      });
      const data = (await res.json()) as Record<string, unknown>;
      check(`upload ${u.label} → 200`, res.status === 200, String(data.error ?? ""));
      if (!convId) convId = data.conversationId as string;
      ids[u.label] = data.id as string;
    }

    console.log("\nWaiting for OCR + transcription (first run downloads models — be patient)…");
    const allIds = Object.values(ids);
    const deadline = Date.now() + 15 * 60_000;
    let rows: Awaited<ReturnType<typeof db.file.findMany>> = [];
    for (;;) {
      rows = await db.file.findMany({ where: { id: { in: allIds } } });
      if (!rows.some((r) => r.status === "pending" || r.status === "processing")) break;
      if (Date.now() > deadline) {
        check("engines finished in time", false);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    const byLabel = (l: string) => rows.find((r) => r.id === ids[l])!;
    const artifactText = (id: string) => {
      const p = join(STORAGE, TENANT, "chats", convId, ".opninfer", `${id}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    };

    const sc = byLabel("scanned");
    const scMeta = (sc.meta ?? {}) as { escalatedFrom?: string; ocr?: boolean };
    const scText = artifactText(sc.id).toUpperCase();
    check(
      "scanned pdf escalated markitdown → docling",
      sc.processorGroup === "docling" && scMeta.escalatedFrom === "markitdown",
      `${sc.status}/${sc.processorGroup} meta=${JSON.stringify(sc.meta)}`,
    );
    check(
      "docling OCR read the page text",
      sc.status === "ready" && scText.includes("DOCLING") && scText.includes("4711"),
      `${sc.error ?? ""} :: ${scText.slice(0, 160)}`,
    );

    const sp = byLabel("speech");
    const spMeta = (sp.meta ?? {}) as { language?: string; durationSeconds?: number };
    const spText = artifactText(sp.id).toLowerCase();
    check(
      "wav transcribed by whisper (audio group)",
      sp.status === "ready" && sp.processorGroup === "audio",
      `${sp.status}/${sp.processorGroup}: ${sp.error ?? ""}`,
    );
    check(
      "transcript contains the spoken words",
      spText.includes("successful") && spText.includes("transcription"),
      spText.slice(0, 200),
    );
    check(
      "language + duration in meta",
      spMeta.language === "en" && (spMeta.durationSeconds ?? 0) > 3,
      JSON.stringify(sp.meta),
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

  console.log(`\n${failures === 0 ? "ALL MILESTONE-D CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
