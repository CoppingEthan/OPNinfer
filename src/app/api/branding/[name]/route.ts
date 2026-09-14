import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  brandingAssetPath,
  brandingAssetExists,
  brandingMime,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/branding/:name — serve a branding image. PUBLIC (excluded from auth
 * middleware) so the logo loads on the login/setup screens. Read-only by name.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const mime = brandingMime(name);
  if (!mime || !(await brandingAssetExists(name))) {
    return new Response("Not found", { status: 404 });
  }

  const webStream = Readable.toWeb(
    createReadStream(brandingAssetPath(name)) as Readable,
  ) as ReadableStream;

  return new Response(webStream, {
    headers: {
      "Content-Type": mime,
      // SVGs can carry scripts; we only ever render via <img>, but lock it down.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
    },
  });
}
