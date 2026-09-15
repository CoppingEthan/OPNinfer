import { createReadStream, existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/pdfjs/... — the PDF viewer's own support files, off this origin.
 *
 * The artifact panel renders PDFs itself rather than handing them to the
 * browser's viewer (see the placeholder gotcha in CLAUDE.md), and that renderer
 * needs three things at runtime: its worker, the character maps that make
 * CJK/Cyrillic text legible, and the metrics for the standard PDF fonts a
 * document may reference without embedding.
 *
 * They are served from `node_modules` rather than copied into `public/`
 * deliberately. A vendored copy is a second source of truth that silently rots
 * the day the package is upgraded — the file would still be served, just from
 * the wrong version, and a font that renders subtly wrong is not a failure
 * anyone would go looking for. Reading them from the installed package means
 * there IS only one version.
 *
 * Auth is the ordinary session, because it rides the middleware matcher like
 * every other /api route and there is no reason to hand a megabyte of worker
 * to anyone who asks. The ALLOWLIST is what makes this safe: without it, a
 * route that resolves a path inside node_modules and streams it is a way to
 * read any dependency's source off the server.
 */

/**
 * Where pdfjs-dist actually is ON DISK.
 *
 * NOT `require.resolve`, and not `createRequire(import.meta.url).resolve`
 * either: webpack rewrites both inside a route bundle into its OWN module
 * path — measured here as `(rsc)/./node_modules/.pnpm/pdfjs-dist@6.3.289/...`
 * — which is not a path any `stat` will ever find. The route then answers 404
 * for every asset, the viewer falls back to its "fake worker", and the only
 * sign is a document that never opens. So this walks the filesystem instead of
 * asking the bundler, and THROWS rather than returning a path that is wrong.
 */
let pkgDir: string | null = null;
function packageDir(): string {
  if (pkgDir) return pkgDir;
  const root = process.cwd();
  const direct = path.join(root, "node_modules", "pdfjs-dist");
  if (existsSync(path.join(direct, "package.json"))) return (pkgDir = direct);

  // A standalone build that did not recreate pnpm's symlink still has the
  // real directory under the virtual store.
  const store = path.join(root, "node_modules", ".pnpm");
  if (existsSync(store)) {
    const hit = readdirSync(store).find((d) => d.startsWith("pdfjs-dist@"));
    if (hit) {
      const nested = path.join(store, hit, "node_modules", "pdfjs-dist");
      if (existsSync(path.join(nested, "package.json"))) return (pkgDir = nested);
    }
  }
  throw new Error("pdfjs-dist is not on disk — the PDF viewer cannot be served");
}

/** Exactly what the viewer asks for, and nothing else. */
const ALLOWED = [
  { prefix: "build/", exact: new Set(["build/pdf.worker.min.mjs", "build/pdf.worker.mjs"]) },
  { prefix: "cmaps/", exact: null },
  { prefix: "standard_fonts/", exact: null },
] as const;

const TYPES: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const rel = (await params).path.join("/");
  // Belt and braces with the allowlist below: a segment that is not a plain
  // name never gets as far as being resolved.
  if (rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) {
    return new Response("Not found", { status: 404 });
  }
  const ok = ALLOWED.some((a) => rel.startsWith(a.prefix) && (!a.exact || a.exact.has(rel)));
  if (!ok) return new Response("Not found", { status: 404 });

  const pkg = packageDir();
  const abs = path.join(pkg, rel);
  // …and the resolved path must still be inside the package, whatever the
  // string arithmetic above did.
  if (!abs.startsWith(pkg + path.sep)) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return new Response("Not found", { status: 404 });
    size = st.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      "Content-Type": TYPES[path.extname(abs)] ?? "application/octet-stream",
      "Content-Length": String(size),
      // Version-locked by the package on disk, and the same for every person —
      // but still private, because the whole tree is behind sign-in.
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
