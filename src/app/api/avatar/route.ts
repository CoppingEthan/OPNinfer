import { auth } from "@/auth";
import { db } from "@/lib/db";
import { saveAvatarAsset, deleteAvatarAsset, brandingMime } from "@/lib/storage";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB — profile pictures are small
const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Refuse an oversized upload from its Content-Length, BEFORE the body is read.
 *
 * `req.formData()` materialises the whole request first, so a size check after
 * it has already paid the cost: the effective ceiling was the middleware body
 * cap (hundreds of MB), not the few MB the code believed it was enforcing, and
 * this app is a single process holding every in-flight reply in memory — so a
 * handful of parallel junk uploads could take out everyone's stream, not just
 * the sender's. A missing or lying header still gets caught by the real check
 * afterwards; this is the cheap door.
 */
function declaredTooLarge(req: Request, maxBytes: number): boolean {
  const len = Number(req.headers.get("content-length") ?? "");
  return Number.isFinite(len) && len > maxBytes;
}

/**
 * POST /api/avatar — the signed-in user uploads their own profile picture
 * (spec: user settings → upload profile icon). Stored as an avatar asset; the
 * bare name is saved on `users.image` and served back via /api/avatar/[name].
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  if (declaredTooLarge(req, MAX_BYTES)) {
    return Response.json({ error: "Image must be 3 MB or smaller." }, { status: 413 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "Image must be 3 MB or smaller." }, { status: 413 });
  }

  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!ALLOWED.has(ext) || !brandingMime(ext)) {
    return Response.json({ error: "Use a PNG, JPG, WEBP, or GIF image." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = await saveAvatarAsset(ext, buffer);

  // Swap it in and clean up the previous asset.
  const prev = await db.user.findUnique({ where: { id: userId }, select: { image: true } });
  await db.user.update({ where: { id: userId }, data: { image: name } });
  if (prev?.image) await deleteAvatarAsset(prev.image);

  await audit("user.avatar_set", { userId, details: { name } });
  return Response.json({ name, url: `/api/avatar/${name}` });
}
