import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { auth } from "@/auth";
import { avatarAssetPath, avatarAssetExists, avatarMime } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/avatar/:name — serve a profile picture. Auth-gated (any signed-in
 * user may load an avatar; names are unguessable UUIDs). Used in the sidebar,
 * the top-right menu, and the admin user table.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { name } = await params;
  const mime = avatarMime(name);
  if (!mime || !(await avatarAssetExists(name))) {
    return new Response("Not found", { status: 404 });
  }

  const webStream = Readable.toWeb(
    createReadStream(avatarAssetPath(name)) as Readable,
  ) as ReadableStream;

  return new Response(webStream, {
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
}
