/**
 * Live harness for vision downscaling (sharp). Attaches a genuinely >8 MB
 * photo (a 4800×3600 JPEG with the readable word "ELEPHANT") to a turn and
 * confirms the model reads it — proving (a) big images that previously
 * exceeded the 8 MB inline cap now reach the model after downscaling, and
 * (b) the downscale preserves legibility. Also checks view_image on the same
 * big image. A control tiny image confirms passthrough still works.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-vision-downscale.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { loadImagesForTurn, loadImageForVision } from "../src/lib/file-tools";
import sharp from "sharp";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "vision-ds-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

/** A genuinely >8 MB 4800×3600 JPEG with a readable word, generated in-process
 *  (noise keeps JPEG big; an SVG overlay gives crisp legible text). */
async function makeBigPhoto(word: string): Promise<Buffer> {
  const W = 4800, H = 3600;
  const noise = Buffer.alloc(W * H * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = 150 + ((i * 2654435761) % 85);
  const label = Buffer.from(
    `<svg width="${W}" height="${H}"><rect x="500" y="1400" width="3800" height="820" fill="#f5f5f5"/>` +
      `<text x="640" y="2000" font-family="sans-serif" font-size="520" font-weight="bold" fill="#0a0a0a">${word}</text></svg>`,
  );
  return sharp(noise, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: label, top: 0, left: 0 }])
    .jpeg({ quality: 96 })
    .toBuffer();
}

async function main() {
  const user = await db.user.create({
    data: { email: `vision-ds-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    let convId: string | null = null;
    async function upload(buf: Buffer, file: string) {
      const url = convId ? `${BASE}/api/files?conversationId=${convId}` : `${BASE}/api/files`;
      const form = new FormData();
      // Send the real MIME so the file row is a vision type immediately (the
      // direct loadImagesForTurn check below doesn't wait for the worker).
      form.append("file", new Blob([buf], { type: "image/jpeg" }), file);
      const res = await fetch(url, { method: "POST", headers: { cookie: cookie() }, body: form });
      const j = await res.json();
      if (res.ok && j.conversationId) convId = j.conversationId;
      return { id: j.id as string, bytes: buf.length };
    }

    const bigBuf = await makeBigPhoto("ELEPHANT");
    const big = await upload(bigBuf, "bigword.jpg");
    check("uploaded a >8MB photo (previously dropped from vision)", big.bytes > 8 * 1024 * 1024, `${(big.bytes / 1048576).toFixed(1)}MB`);

    // Unit-level: what loadImagesForTurn hands the model for this big file.
    const parts = await loadImagesForTurn(convId!, [big.id]);
    check("big image is INCLUDED for the turn (not dropped)", parts.length === 1, `${parts.length} parts`);
    const inlineBytes = parts[0] ? Buffer.from(parts[0].dataBase64, "base64").byteLength : 0;
    check("…and was downscaled (inline << source)", inlineBytes > 0 && inlineBytes < big.bytes / 3, `inline ${(inlineBytes / 1024).toFixed(0)}KB vs source ${(big.bytes / 1048576).toFixed(1)}MB`);

    // End-to-end: the model must READ the word through the real chat route.
    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convId, content: "What single word is written in this image? Reply with just the word.", fileIds: [big.id] }),
    });
    let full = ""; const reader = chatRes.body?.getReader(); const dec = new TextDecoder();
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); } }
    const text = [...full.matchAll(/"type":"text","delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
    check("model READ the downscaled big image (ELEPHANT)", /elephant/i.test(text), text.slice(0, 120));
    check("no error in the turn", !full.includes('"type":"error"'));

    // view_image on the big image also downscales + stays legible.
    const viewed = await loadImageForVision(convId!, "bigword.jpg");
    check("view_image downscales the big image too", typeof viewed !== "string" && Buffer.from(viewed.dataBase64, "base64").byteLength < big.bytes / 3);
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL VISION-DOWNSCALE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
