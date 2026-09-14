import "server-only";
import sharp from "sharp";
import { devLog } from "./dev-log";
import type { ImagePart } from "./providers/types";

/**
 * Downscale an image before it's sent to a Gemini/vision model. Providers bill
 * by pixel count and see no extra detail past a couple of megapixels, so a
 * full-resolution phone/DSLR photo costs more tokens than the model can use.
 * Capping the long edge cuts cost AND keeps the base64 payload small enough to
 * inline (a 12 MB photo becomes a few hundred KB), so big uploads actually
 * reach the model instead of being dropped by the size guard.
 *
 * Uploads are ALWAYS kept full-resolution on disk (the user's original is
 * preserved for download) — only the COPY sent to the model is downscaled.
 *
 * Two families of profile:
 *  - VISION — attached-turn images + view_image (aggressive, ~1.5 MP).
 *  - EDIT   — image_edit / image_blend SOURCES, in two tiers that track the
 *             output quality the user picked (standard→Flash/1K, max→Pro/2K).
 *             Mirrors an earlier in-house toolset's two compression profiles: its ~2 MP LLM
 *             profile (normal) and its 2048 px disk profile (pro). Unlike OWUI
 *             we keep the format family (PNG stays PNG) instead of forcing JPEG,
 *             so transparency survives.
 */

interface DownscaleProfile {
  /** Long-edge cap in px. Never enlarges. */
  longEdge: number;
  /** Re-encode quality for lossy outputs (jpeg/webp). */
  quality: number;
  /** Re-encode even an in-spec image if it's bloated past this (bytes). */
  recompressOver: number;
}

/** Vision path — the model sees no extra detail past ~1.5 MP. */
const VISION: DownscaleProfile = {
  longEdge: Number(process.env.VISION_MAX_LONG_EDGE ?? 1568),
  quality: Number(process.env.VISION_IMAGE_QUALITY ?? 82),
  recompressOver: Number(process.env.VISION_RECOMPRESS_BYTES ?? 1_500_000),
};

/** Edit/blend SOURCE, "normal" tier (standard quality → Flash/1K output).
 *  an earlier in-house toolset's LLM profile: ~2 MP. */
const EDIT_NORMAL: DownscaleProfile = {
  longEdge: Number(process.env.EDIT_NORMAL_LONG_EDGE ?? 1414),
  quality: Number(process.env.EDIT_NORMAL_QUALITY ?? 80),
  recompressOver: Number(process.env.EDIT_NORMAL_RECOMPRESS_BYTES ?? 1_500_000),
};

/** Edit/blend SOURCE, "pro" tier (max quality → Pro/2K output).
 *  an earlier in-house toolset's disk profile: 2048 px / q85 — more source detail for the
 *  higher-fidelity 2K output. */
const EDIT_PRO: DownscaleProfile = {
  longEdge: Number(process.env.EDIT_PRO_LONG_EDGE ?? 2048),
  quality: Number(process.env.EDIT_PRO_QUALITY ?? 85),
  recompressOver: Number(process.env.EDIT_PRO_RECOMPRESS_BYTES ?? 4_000_000),
};

/** Only these ride a turn as native vision (every provider accepts them). */
export const VISION_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

/**
 * Downscale raw image bytes in the same format family: EXIF-auto-rotate, cap the
 * long edge, re-encode. Never enlarges. Falls back to the ORIGINAL bytes if
 * sharp can't process it (e.g. an exotic/animated frame) so the model still
 * sees something. Returns an `ImagePart` ready to base64-inline.
 */
async function downscaleInFamily(
  data: Buffer,
  mime: string,
  cfg: DownscaleProfile,
  reason: string,
): Promise<ImagePart> {
  const m = mime.toLowerCase();
  const passthrough = (): ImagePart => ({ mimeType: m, dataBase64: data.toString("base64") });

  try {
    const img = sharp(data, { failOn: "none", animated: false });
    const meta = await img.metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const needsResize = longest > cfg.longEdge;
    const needsRecompress = data.byteLength > cfg.recompressOver;
    if (!needsResize && !needsRecompress) return passthrough();

    let pipe = img.rotate(); // honour EXIF orientation → the model sees it upright
    if (needsResize) {
      pipe = pipe.resize({ width: cfg.longEdge, height: cfg.longEdge, fit: "inside", withoutEnlargement: true });
    }

    // Keep the family: JPEG/GIF → JPEG (photos), PNG → PNG (text/graphics stay
    // crisp AND alpha survives), WebP → WebP. Output mime stays in VISION_MIMES.
    let out: Buffer;
    let outMime: string;
    if (m === "image/png") {
      out = await pipe.png({ compressionLevel: 9 }).toBuffer();
      outMime = "image/png";
    } else if (m === "image/webp") {
      out = await pipe.webp({ quality: cfg.quality }).toBuffer();
      outMime = "image/webp";
    } else {
      // jpeg + gif (first frame) → jpeg
      out = await pipe.jpeg({ quality: cfg.quality, mozjpeg: true }).toBuffer();
      outMime = "image/jpeg";
    }

    // Only adopt the re-encode if it actually helped (a tiny PNG can grow).
    if (out.byteLength < data.byteLength) {
      devLog("debug", "vision", `image downscaled for ${reason}`, {
        from: `${meta.width}×${meta.height}, ${data.byteLength} bytes`,
        to: `long edge ≤${cfg.longEdge}, ${out.byteLength} bytes as ${outMime}`,
        reduction: `${(data.byteLength / out.byteLength).toFixed(1)}×`,
      });
      return { mimeType: outMime, dataBase64: out.toString("base64") };
    }
    return passthrough();
  } catch {
    return passthrough();
  }
}

/** Prepare an image for the VISION path (attached turn images + view_image). */
export async function prepareImageForVision(data: Buffer, mime: string): Promise<ImagePart> {
  return downscaleInFamily(data, mime, VISION, "the model");
}

/**
 * Prepare an image_edit / image_blend SOURCE for Gemini. Downscaled to the tier
 * matching the requested output quality — "max" gets the higher-res pro profile,
 * everything else the normal profile. The on-disk upload is untouched.
 */
export async function prepareImageForEdit(
  data: Buffer,
  mime: string,
  quality: "standard" | "max",
): Promise<ImagePart> {
  const pro = quality === "max";
  return downscaleInFamily(data, mime, pro ? EDIT_PRO : EDIT_NORMAL, `image edit (${pro ? "pro" : "normal"})`);
}
