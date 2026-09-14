import { auth } from "@/auth";
import { saveBrandingAsset, brandingMime } from "@/lib/storage";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — logos/icons are small
const ALLOWED = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** POST /api/branding — admin uploads a branding image, returns its name. */
export async function POST(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "Image must be 2 MB or smaller." }, { status: 413 });
  }

  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!ALLOWED.has(ext) || !brandingMime(ext)) {
    return Response.json(
      { error: "Use an SVG, PNG, JPG, WEBP, or GIF image." },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = await saveBrandingAsset(ext, buffer);
  await audit("branding.upload", {
    userId: session.user.id,
    details: { name, bytes: buffer.byteLength },
  });

  return Response.json({ name, url: `/api/branding/${name}` });
}
