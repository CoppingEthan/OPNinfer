/**
 * End-to-end ingestion smoke (NOT in the test suite). Requires BOTH the dev
 * server AND the worker container running:
 *
 *   docker compose -f docker-compose.dev.yml up -d worker
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
 *   node --env-file=.env --import tsx scripts/test-ingestion-http.ts
 *
 * Uploads one file per Group-1 shape (text passthrough, markdown, real DOCX,
 * real PDF, PNG, zip, binary), waits for the worker to process them, then
 * asserts statuses, processor groups, artifacts on disk, and the status API.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "ingest-smoke-pw-7712!";
const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";

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

// --- fixture builders --------------------------------------------------------

/** A minimal but VALID single-page PDF with a correct xref table. */
function buildPdf(text: string): Buffer {
  const esc = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A minimal but VALID .docx (OOXML zip) mammoth/MarkItDown can read. */
async function buildDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fileForm(name: string, content: Buffer | string, type: string) {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type }));
  return fd;
}

// --- main ---------------------------------------------------------------------

const PDF_TEXT =
  "This is a genuine PDF document used by the OPNinfer ingestion smoke test. " +
  "It contains more than two hundred characters of extractable text so the " +
  "MarkItDown handler treats it as a text PDF rather than escalating it to the " +
  "Docling OCR engine. The quick brown fox jumps over the lazy dog.";

async function main() {
  const cleanupUserIds: string[] = [];
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `ingest-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    cleanupUserIds.push(user.id);
    const s = new Session();
    check("login", await s.login(user.email));

    // -- upload one of each shape ------------------------------------------
    const uploads: {
      label: string;
      name: string;
      body: Buffer | string;
      type: string;
    }[] = [
      { label: "txt", name: "notes.txt", body: "hello worker, plain text here", type: "text/plain" },
      { label: "md", name: "README.md", body: "# Title\n\nSome **markdown** body.", type: "text/markdown" },
      { label: "json", name: "config.json", body: '{"alpha":1,"beta":[2,3]}', type: "application/json" },
      { label: "docx", name: "report.docx", body: await buildDocx("Hello from a real DOCX fixture."), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { label: "pdf", name: "paper.pdf", body: buildPdf(PDF_TEXT), type: "application/pdf" },
      { label: "png", name: "pixel.png", body: PNG_1PX, type: "image/png" },
      { label: "bin", name: "blob.bin", body: Buffer.concat([Buffer.from([0, 1, 2, 0, 255]), Buffer.alloc(64, 7)]), type: "application/octet-stream" },
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

    // zip containing a text member — MarkItDown walks archive contents.
    const zip = new JSZip();
    zip.file("inside.txt", "text hidden inside a zip archive");
    const zres = await s.fetch(`/api/files?conversationId=${convId}`, {
      method: "POST",
      body: fileForm("bundle.zip", await zip.generateAsync({ type: "nodebuffer" }), "application/zip"),
    });
    ids.zip = ((await zres.json()) as Record<string, unknown>).id as string;

    // -- wait for the worker to finish everything ---------------------------
    console.log("\nWaiting for the worker…");
    const allIds = Object.values(ids);
    const deadline = Date.now() + 120_000;
    let rows: Awaited<ReturnType<typeof db.file.findMany>> = [];
    for (;;) {
      rows = await db.file.findMany({ where: { id: { in: allIds } } });
      const busy = rows.filter((r) => r.status === "pending" || r.status === "processing");
      if (busy.length === 0) break;
      if (Date.now() > deadline) {
        check("worker finished all files in time", false, `${busy.length} still busy`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byLabel = (label: string) => rows.find((r) => r.id === ids[label])!;
    const artifact = (fileId: string) =>
      join(STORAGE, TENANT, "chats", convId, ".opninfer", `${fileId}.md`);
    const artifactText = (fileId: string) =>
      existsSync(artifact(fileId)) ? readFileSync(artifact(fileId), "utf8") : "";

    // -- assertions ----------------------------------------------------------
    const txt = byLabel("txt");
    check(
      "txt → ready via passthrough, artifact matches",
      txt.status === "ready" && txt.processorGroup === "passthrough" &&
        artifactText(txt.id) === "hello worker, plain text here",
      `${txt.status}/${txt.processorGroup}`,
    );
    const md = byLabel("md");
    check(
      "md → ready, artifact contains body",
      md.status === "ready" && artifactText(md.id).includes("markdown"),
      `${md.status}/${md.processorGroup}`,
    );
    const json = byLabel("json");
    check(
      "json → ready via passthrough (UTF-8 sweep)",
      json.status === "ready" && json.processorGroup === "passthrough",
      `${json.status}/${json.processorGroup}`,
    );
    const docx = byLabel("docx");
    check(
      "docx → ready via markitdown, text extracted",
      docx.status === "ready" && docx.processorGroup === "markitdown" &&
        artifactText(docx.id).includes("Hello from a real DOCX"),
      `${docx.status}/${docx.processorGroup}: ${docx.error ?? ""}`,
    );
    const pdf = byLabel("pdf");
    check(
      "pdf → ready via markitdown, text extracted",
      pdf.status === "ready" && pdf.processorGroup === "markitdown" &&
        artifactText(pdf.id).includes("quick brown fox"),
      `${pdf.status}/${pdf.processorGroup}: ${pdf.error ?? ""}`,
    );
    const png = byLabel("png");
    const pngMeta = (png.meta ?? {}) as { width?: number; height?: number };
    check(
      "png → ready as image, dimensions in meta",
      png.status === "ready" && png.processorGroup === "image" &&
        pngMeta.width === 1 && pngMeta.height === 1,
      JSON.stringify(png.meta),
    );
    const bin = byLabel("bin");
    check(
      "binary → unsupported via metadata fallback",
      bin.status === "unsupported" && bin.processorGroup === "metadata",
      `${bin.status}/${bin.processorGroup}`,
    );
    const zrow = byLabel("zip");
    check(
      "zip → markitdown walks members",
      zrow.status === "ready" && artifactText(zrow.id).includes("hidden inside a zip"),
      `${zrow.status}/${zrow.processorGroup}: ${zrow.error ?? ""}`,
    );
    check(
      "detected mime recorded from magic bytes (pdf)",
      pdf.detectedMime === "application/pdf",
      String(pdf.detectedMime),
    );
    check(
      "token estimates recorded for ready files",
      (txt.tokenEstimate ?? 0) > 0 && (pdf.tokenEstimate ?? 0) > 0,
    );

    // -- status endpoint over HTTP -------------------------------------------
    const st = await s.fetch(`/api/files/status?ids=${allIds.join(",")}`);
    const stData = (await st.json()) as { files: { id: string; status: string }[] };
    check(
      "status API returns all rows",
      st.status === 200 && stData.files.length === allIds.length,
      `${stData.files?.length} rows`,
    );
  } finally {
    for (const id of cleanupUserIds) {
      await db.user.delete({ where: { id } }).catch(() => {});
    }
    if (convId) {
      const { rmSync } = await import("node:fs");
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up throwaway user and pool.");
  }

  console.log(`\n${failures === 0 ? "ALL INGESTION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
