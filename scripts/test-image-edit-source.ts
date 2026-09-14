/**
 * Live harness for image_edit / image_blend SOURCE compression (the OWUI-style
 * auto-downscale). Uploads real files into a conversation pool through the
 * actual /api/files route, then drives the real `loadImageByName` path and
 * asserts:
 *   - a >8 MB source is NO LONGER rejected (old 8 MB cliff) — it downscales;
 *   - standard quality → NORMAL tier (~1414 px), max → PRO tier (2048 px);
 *   - PNG transparency SURVIVES the downscale (we don't force-JPEG like OWUI);
 *   - the on-disk upload is left FULL-RES (non-destructive — only the copy sent
 *     to Gemini is shrunk).
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-image-edit-source.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { loadImageByName } from "../src/lib/file-tools";
import { resolveStoredPath } from "../src/lib/storage";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "edit-src-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function edge(b64: string) {
  const m = await sharp(Buffer.from(b64, "base64")).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0, long: Math.max(m.width ?? 0, m.height ?? 0), format: m.format, alpha: m.hasAlpha };
}

/** A genuinely >8 MB 4800×3600 JPEG — real xorshift noise stays incompressible. */
async function makeBigJpeg(): Promise<Buffer> {
  const W = 4800, H = 3600;
  const noise = Buffer.alloc(W * H * 3);
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < noise.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    noise[i] = s & 0xff;
  }
  return sharp(noise, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 97 }).toBuffer();
}

/** A 2600×2600 RGBA PNG with a fully-transparent quadrant. */
async function makeAlphaPng(): Promise<Buffer> {
  const W = 2600, H = 2600;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      rgba[o] = (x * 255 / W) | 0; rgba[o + 1] = (y * 255 / H) | 0; rgba[o + 2] = 90;
      rgba[o + 3] = x > W / 2 && y > H / 2 ? 0 : 255; // transparent bottom-right
    }
  }
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function main() {
  const user = await db.user.create({
    data: { email: `edit-src-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  let convId: string | null = null;
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    async function upload(buf: Buffer, file: string, type: string) {
      const url = convId ? `${BASE}/api/files?conversationId=${convId}` : `${BASE}/api/files`;
      const form = new FormData();
      form.append("file", new Blob([buf], { type }), file);
      const res = await fetch(url, { method: "POST", headers: { cookie: cookie() }, body: form });
      const j = await res.json();
      if (res.ok && j.conversationId) convId = j.conversationId;
      return { id: j.id as string, bytes: buf.length };
    }

    // ---- 1. Big JPEG: the 8 MB cliff is gone; tiers downscale correctly ----
    const bigBuf = await makeBigJpeg();
    const big = await upload(bigBuf, "bigphoto.jpg", "image/jpeg");
    check("uploaded a >8MB source (would previously be rejected for edit)", big.bytes > 8 * 1024 * 1024, `${(big.bytes / 1048576).toFixed(1)}MB`);

    const std = await loadImageByName(convId!, "bigphoto.jpg", "standard");
    check("standard edit no longer rejects the >8MB source", typeof std !== "string", typeof std === "string" ? std : "");
    if (typeof std !== "string") {
      const e = await edge(std.dataBase64);
      check("standard → NORMAL tier (~1414px long edge)", e.long === 1414, `long=${e.long}`);
      check("standard source payload << original", Buffer.from(std.dataBase64, "base64").byteLength < big.bytes / 3, `${(Buffer.from(std.dataBase64, "base64").byteLength / 1024).toFixed(0)}KB`);
    }

    const mx = await loadImageByName(convId!, "bigphoto.jpg", "max");
    if (typeof mx !== "string") {
      const e = await edge(mx.dataBase64);
      check("max → PRO tier (2048px long edge)", e.long === 2048, `long=${e.long}`);
    }
    if (typeof std !== "string" && typeof mx !== "string") {
      check("pro keeps more source resolution than normal",
        (await edge(mx.dataBase64)).long > (await edge(std.dataBase64)).long);
    }

    // ---- 2. Non-destructive: the on-disk upload is still full-res ----
    const row = await db.file.findUnique({ where: { id: big.id } });
    const onDisk = row ? await readFile(resolveStoredPath(row.storagePath)) : Buffer.alloc(0);
    const diskMeta = await sharp(onDisk).metadata();
    check("on-disk original UNTOUCHED (still 4800px, full bytes)",
      diskMeta.width === 4800 && onDisk.byteLength === big.bytes, `${diskMeta.width}px, ${(onDisk.byteLength / 1048576).toFixed(1)}MB`);

    // ---- 3. PNG transparency survives the downscale (no force-JPEG) ----
    const pngBuf = await makeAlphaPng();
    const png = await upload(pngBuf, "logo.png", "image/png");
    const pe = await loadImageByName(convId!, "logo.png", "max");
    check("PNG source loads for edit", typeof pe !== "string");
    if (typeof pe !== "string") {
      const e = await edge(pe.dataBase64);
      check("PNG stays PNG (not force-converted to JPEG)", pe.mimeType === "image/png" && e.format === "png", `${pe.mimeType}/${e.format}`);
      check("PNG transparency PRESERVED through downscale", e.alpha === true);
      check("PNG downscaled to pro tier (2048px)", e.long === 2048, `long=${e.long}`);
    }
    void png;
  } finally {
    if (convId) await db.conversation.delete({ where: { id: convId } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL IMAGE-EDIT-SOURCE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
