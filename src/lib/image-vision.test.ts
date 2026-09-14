import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareImageForEdit, prepareImageForVision } from "./image-vision";

async function dims(b64: string) {
  const m = await sharp(Buffer.from(b64, "base64")).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0, format: m.format };
}

describe("prepareImageForVision", () => {
  it("downscales a large JPEG to the long-edge cap and shrinks the payload", async () => {
    const big = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 80, b: 20 } },
    }).jpeg({ quality: 95 }).toBuffer();

    const out = await prepareImageForVision(big, "image/jpeg");
    const { w, h, format } = await dims(out.dataBase64);
    expect(Math.max(w, h)).toBeLessThanOrEqual(1568);
    expect(w).toBe(1568); // 4000→1568, aspect kept
    expect(h).toBe(1176);
    expect(format).toBe("jpeg");
    expect(Buffer.from(out.dataBase64, "base64").byteLength).toBeLessThan(big.byteLength);
  });

  it("keeps a PNG as PNG (crisp text/graphics) when downscaling", async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer();
    const out = await prepareImageForVision(big, "image/png");
    const { w, format } = await dims(out.dataBase64);
    expect(w).toBe(1568);
    expect(format).toBe("png");
    expect(out.mimeType).toBe("image/png");
  });

  it("keeps WebP as WebP", async () => {
    const big = await sharp({
      create: { width: 2400, height: 2400, channels: 3, background: { r: 10, g: 40, b: 90 } },
    }).webp().toBuffer();
    const out = await prepareImageForVision(big, "image/webp");
    const { w, h, format } = await dims(out.dataBase64);
    expect(Math.max(w, h)).toBe(1568);
    expect(format).toBe("webp");
  });

  it("leaves a small in-spec image untouched (passthrough)", async () => {
    const small = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg({ quality: 70 }).toBuffer();
    const out = await prepareImageForVision(small, "image/jpeg");
    // identical bytes back — no re-encode
    expect(out.dataBase64).toBe(small.toString("base64"));
    expect(out.mimeType).toBe("image/jpeg");
  });

  it("falls back to the original bytes on undecodable input", async () => {
    const junk = Buffer.from("not an image at all", "utf8");
    const out = await prepareImageForVision(junk, "image/png");
    expect(out.dataBase64).toBe(junk.toString("base64"));
    expect(out.mimeType).toBe("image/png");
  });

  it("does not enlarge an image below the cap", async () => {
    const mid = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).png().toBuffer();
    const out = await prepareImageForVision(mid, "image/png");
    const { w, h } = await dims(out.dataBase64);
    expect(w).toBe(800);
    expect(h).toBe(600);
  });
});

describe("prepareImageForEdit (image_edit / image_blend source compression)", () => {
  const bigPhoto = () =>
    sharp({ create: { width: 5000, height: 5000, channels: 3, background: { r: 100, g: 60, b: 30 } } })
      .jpeg({ quality: 95 })
      .toBuffer();

  it("standard quality → NORMAL tier (~1414 px long edge)", async () => {
    const out = await prepareImageForEdit(await bigPhoto(), "image/jpeg", "standard");
    const { w, h } = await dims(out.dataBase64);
    expect(Math.max(w, h)).toBe(1414);
  });

  it("max quality → PRO tier (2048 px long edge — more source detail for 2K output)", async () => {
    const out = await prepareImageForEdit(await bigPhoto(), "image/jpeg", "max");
    const { w, h } = await dims(out.dataBase64);
    expect(Math.max(w, h)).toBe(2048);
  });

  it("pro keeps strictly more source resolution than normal", async () => {
    const src = await bigPhoto();
    const normal = await dims((await prepareImageForEdit(src, "image/jpeg", "standard")).dataBase64);
    const pro = await dims((await prepareImageForEdit(src, "image/jpeg", "max")).dataBase64);
    expect(pro.w).toBeGreaterThan(normal.w);
  });

  it("downscaling a source shrinks the payload sent to Gemini", async () => {
    const src = await bigPhoto();
    const out = await prepareImageForEdit(src, "image/jpeg", "max");
    expect(Buffer.from(out.dataBase64, "base64").byteLength).toBeLessThan(src.byteLength);
  });

  it("PRESERVES PNG transparency (does NOT force-JPEG like OWUI) — alpha survives an edit", async () => {
    // A 3000px PNG with a fully-transparent quadrant.
    const png = await sharp({
      create: { width: 3000, height: 3000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const out = await prepareImageForEdit(png, "image/png", "max");
    expect(out.mimeType).toBe("image/png");
    const meta = await sharp(Buffer.from(out.dataBase64, "base64")).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true); // transparency preserved through the downscale
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(2048);
  });

  it("leaves a small source untouched (no needless quality loss)", async () => {
    const small = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 7, g: 7, b: 7 } },
    }).jpeg({ quality: 70 }).toBuffer();
    const out = await prepareImageForEdit(small, "image/jpeg", "standard");
    expect(out.dataBase64).toBe(small.toString("base64")); // identical bytes, passthrough
  });
});
