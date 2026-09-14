import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getBranding } from "@/lib/branding";
import { IS_CONSOLE } from "@/lib/mode";
import { brandingAssetExists, brandingAssetPath } from "@/lib/storage";
import { ALLOWED_ICON_SIZES, PWA_BACKGROUND } from "@/lib/pwa";

export const dynamic = "force-dynamic";

/**
 * GET /api/pwa/icon?size=192[&maskable=1][&v=…] — a home-screen icon for THIS
 * portal, rendered from the admin's uploaded logo, or the default mark when
 * there isn't one.
 *
 * PUBLIC, like /api/branding/[name] and for the same reason: the browser
 * fetches manifest icons with credentials omitted, so behind auth it would
 * store the login page's HTML as the icon. It shows the same logo the login
 * screen already shows to anyone who loads it.
 *
 * Rendered rather than committed as files because the logo is per instance and
 * changes whenever an admin uploads a new one — a checked-in icon set could
 * only ever be OPNinfer's own mark.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  // A fixed allowlist, so this can never be used as a general image resizer
  // (an unbounded `size` is a trivial way to make a server render 20000px PNGs).
  const size = Number(url.searchParams.get("size") ?? 0);
  if (!ALLOWED_ICON_SIZES.includes(size)) {
    return new Response("Unsupported icon size", { status: 400 });
  }
  const maskable = url.searchParams.get("maskable") === "1";

  const source = await iconSource();

  // Android masks an icon to the launcher's shape and can crop the outer ~10%,
  // so a maskable rendering holds the art inside that safe zone. Everything is
  // flattened onto an opaque tile: iOS composites a transparent apple-touch
  // icon onto black, and a maskable icon may not be transparent at all.
  const pad = maskable ? Math.round(size * 0.1) : 0;
  const inner = size - pad * 2;

  let image = sharp(source, { density: 384 }).resize(inner, inner, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (pad > 0) {
    image = image.extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: PWA_BACKGROUND,
    });
  }
  const png = await image.flatten({ background: PWA_BACKGROUND }).png().toBuffer();

  // A `v` token makes the URL unique to one uploaded logo, so it can be cached
  // for good; the un-versioned form (the apple-touch-icon <link>) revalidates
  // daily instead.
  const versioned = url.searchParams.has("v");

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Cache-Control": versioned
        ? "public, max-age=31536000, immutable"
        : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The admin's logo when there is a usable one, else the default mark that
 * ships in the image. A logo that has gone missing falls back rather than
 * failing: everywhere else in the app an absent branding asset just means the
 * default mark, and a 404 here would leave a phone with a blank home-screen
 * tile it never retries.
 */
async function iconSource(): Promise<Buffer> {
  if (!IS_CONSOLE) {
    const { logo } = await getBranding();
    if (logo && (await brandingAssetExists(logo))) {
      try {
        return await readFile(brandingAssetPath(logo));
      } catch {
        /* fall through to the default mark */
      }
    }
  }
  // public/ is COPYed into the runtime image by the Dockerfile; the standalone
  // build traces JS imports only, so a plain file read here depends on that
  // line (pinned by pwa.test.ts).
  return readFile(path.join(process.cwd(), "public", "icon.png"));
}
