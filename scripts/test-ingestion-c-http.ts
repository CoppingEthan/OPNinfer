/**
 * Milestone C smoke — specialist handlers (NOT in the test suite). Requires
 * the dev server + worker + gotenberg containers running, plus prebuilt
 * fixtures (inventory.xlsx / clip.mp4) in FIXTURES_DIR:
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; $env:FIXTURES_DIR='…'
 *   node --env-file=.env --experimental-sqlite --import tsx scripts/test-ingestion-c-http.ts
 *
 * Covers: CSV full-dump vs schema, XLSX workbook overview, SQLite
 * introspection, RTF → Gotenberg → PDF → MarkItDown, MP4 → ffprobe metadata.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "ingest-c-pw-3319!";
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

async function buildSqlite(): Promise<Buffer> {
  // node:sqlite (--experimental-sqlite on Node 22) writes a genuine DB file.
  const { DatabaseSync } = await import("node:sqlite");
  const tmp = join(tmpdir(), `oi-smoke-${Date.now()}.sqlite`);
  const d = new DatabaseSync(tmp);
  d.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      total REAL NOT NULL
    );
  `);
  const ins = d.prepare("INSERT INTO customers (name, email) VALUES (?, ?)");
  for (let i = 1; i <= 42; i++) ins.run(`Customer ${i}`, `c${i}@ex.test`);
  const ord = d.prepare("INSERT INTO orders (customer_id, total) VALUES (?, ?)");
  for (let i = 1; i <= 7; i++) ord.run(i, i * 10.5);
  d.close();
  const buf = readFileSync(tmp);
  rmSync(tmp, { force: true });
  return buf;
}

const RTF = String.raw`{\rtf1\ansi\deff0 {\fonttbl {\f0 Times New Roman;}}\f0\fs24 Hello from a legacy RTF document. OPNinfer milestone C smoke fixture.\par}`;

const bigCsv = ["idx,city,population"]
  .concat(
    Array.from({ length: 500 }, (_, i) => `${i + 1},City${i + 1},${(i + 1) * 1000}`),
  )
  .join("\n");

async function main() {
  if (!FIXTURES || !existsSync(join(FIXTURES, "inventory.xlsx"))) {
    throw new Error("FIXTURES_DIR with inventory.xlsx/clip.mp4 is required.");
  }
  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `ingest-c-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const s = new Session();
    check("login", await s.login(user.email));

    const uploads = [
      { label: "csvSmall", name: "prices.csv", body: "item,price\nWidget,9.99\nGadget,19.5\nDoohickey,3.25", type: "text/csv" },
      { label: "csvBig", name: "cities.csv", body: bigCsv, type: "text/csv" },
      { label: "xlsx", name: "inventory.xlsx", body: readFileSync(join(FIXTURES, "inventory.xlsx")), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { label: "sqlite", name: "app.sqlite", body: await buildSqlite(), type: "application/octet-stream" },
      { label: "rtf", name: "memo.rtf", body: RTF, type: "application/rtf" },
      { label: "mp4", name: "clip.mp4", body: readFileSync(join(FIXTURES, "clip.mp4")), type: "video/mp4" },
    ];

    const ids: Record<string, string> = {};
    for (const u of uploads) {
      const params = convId ? `conversationId=${convId}` : "";
      const res = await s.fetch(`/api/files?${params}`, {
        method: "POST",
        body: fileForm(u.name, u.body, u.type),
      });
      const data = (await res.json()) as Record<string, unknown>;
      check(`upload ${u.label} → 200`, res.status === 200, String(data.error ?? ""));
      if (!convId) convId = data.conversationId as string;
      ids[u.label] = data.id as string;
    }

    console.log("\nWaiting for the worker (RTF needs a Gotenberg round-trip)…");
    const allIds = Object.values(ids);
    const deadline = Date.now() + 180_000;
    let rows: Awaited<ReturnType<typeof db.file.findMany>> = [];
    for (;;) {
      rows = await db.file.findMany({ where: { id: { in: allIds } } });
      if (!rows.some((r) => r.status === "pending" || r.status === "processing")) break;
      if (Date.now() > deadline) {
        check("worker finished in time", false);
        break;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    const byLabel = (l: string) => rows.find((r) => r.id === ids[l])!;
    const artifactText = (id: string) => {
      const p = join(STORAGE, TENANT, "chats", convId, ".opninfer", `${id}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    };

    // --- CSV: tiny → full dump ------------------------------------------------
    const cs = byLabel("csvSmall");
    const csMeta = (cs.meta ?? {}) as { fullDump?: boolean };
    check(
      "small csv → full dump with real values",
      cs.status === "ready" && cs.processorGroup === "spreadsheet" &&
        csMeta.fullDump === true && artifactText(cs.id).includes("Doohickey"),
      `${cs.status}/${cs.processorGroup}: ${cs.error ?? ""}`,
    );

    // --- CSV: big → schema + sample, NOT the data ------------------------------
    const cb = byLabel("csvBig");
    const cbMeta = (cb.meta ?? {}) as { fullDump?: boolean; rows?: number };
    const cbText = artifactText(cb.id);
    check(
      "500-row csv → schema overview (500 rows recorded, row 400 NOT dumped)",
      cb.status === "ready" && cbMeta.fullDump === false && cbMeta.rows === 500 &&
        cbText.includes("schema overview") && !cbText.includes("City400"),
      `rows=${cbMeta.rows}`,
    );

    // --- XLSX workbook overview -------------------------------------------------
    const xl = byLabel("xlsx");
    const xlMeta = (xl.meta ?? {}) as { sheets?: { name: string; rows: number }[] };
    const xlText = artifactText(xl.id);
    check(
      "xlsx → 2-sheet overview with headers + true row counts",
      xl.status === "ready" && xl.processorGroup === "spreadsheet" &&
        xlMeta.sheets?.length === 2 &&
        xlMeta.sheets.find((sh) => sh.name === "Inventory")?.rows === 300 &&
        xlText.includes("Suppliers") && xlText.includes("unit_price"),
      `${xl.status}: ${JSON.stringify(xlMeta.sheets)} ${xl.error ?? ""}`,
    );

    // --- SQLite introspection ----------------------------------------------------
    const sq = byLabel("sqlite");
    const sqText = artifactText(sq.id);
    check(
      "sqlite → schema with tables, FK, and row counts (no data)",
      sq.status === "ready" && sq.processorGroup === "database" &&
        sqText.includes("customers") && sqText.includes("42") &&
        sqText.includes("FK `customer_id` → `customers`.`id`") &&
        !sqText.includes("c7@ex.test"),
      `${sq.status}/${sq.processorGroup}: ${sq.error ?? ""}`,
    );

    // --- RTF via Gotenberg ---------------------------------------------------------
    const rt = byLabel("rtf");
    const rtMeta = (rt.meta ?? {}) as { convertedVia?: string };
    check(
      "rtf → gotenberg → pdf → markitdown text",
      rt.status === "ready" && rt.processorGroup === "libreoffice" &&
        rtMeta.convertedVia === "gotenberg" &&
        artifactText(rt.id).includes("legacy RTF document"),
      `${rt.status}/${rt.processorGroup}: ${rt.error ?? ""}`,
    );

    // --- MP4 ffprobe metadata ---------------------------------------------------
    const mp = byLabel("mp4");
    const mpMeta = (mp.meta ?? {}) as {
      width?: number; durationSeconds?: number; hasAudio?: boolean; videoCodec?: string;
    };
    check(
      "mp4 → ffprobe metadata (64px, ~1s, audio track), content stays empty",
      mp.status === "ready" && mp.processorGroup === "video" &&
        mpMeta.width === 64 && mpMeta.hasAudio === true &&
        (mpMeta.durationSeconds ?? 0) > 0.5 && mp.contentPath === null,
      JSON.stringify(mp.meta),
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

  console.log(`\n${failures === 0 ? "ALL MILESTONE-C CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
