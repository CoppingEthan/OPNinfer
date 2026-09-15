import "server-only";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStoredPathForRead, storageRoot } from "@/lib/storage";
import { devLog } from "@/lib/dev-log";

/**
 * Word, Excel and PowerPoint previewed with their REAL layout.
 *
 * The obvious answer is a client-side renderer per format — docx-preview,
 * SheetJS, one of the pptx libraries — which is three dependencies, three sets
 * of fidelity bugs, and three things to keep up to date. The better answer was
 * already running: **Gotenberg**, the LibreOffice container the ingestion
 * worker uses to normalise legacy Office files. It lays a document out exactly
 * as the office suite would and hands back a PDF, which every browser renders
 * natively.
 *
 * So the preview is: convert once, cache the PDF beside the file's other
 * prepared artifacts, and serve that. Conversion is seconds, and nobody should
 * pay it twice for the same document.
 *
 * When the engine is not configured or not reachable, the caller falls back to
 * the text the ingestion worker already extracted. Degrading to "the words,
 * without the layout" is honest; a spinner that never resolves is not.
 */

const CONVERT_TIMEOUT_MS = 60_000;

export function gotenbergUrl(): string | null {
  const url = process.env.GOTENBERG_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** Where a converted PDF lives: alongside the `.opninfer/<id>.md` the worker
 *  writes, so it is inside the chat's pool and dies with the conversation. */
function cachePath(contentPath: string | null, fileId: string): string | null {
  if (!contentPath) return null;
  const dir = path.dirname(contentPath);
  return path.posix.join(dir, `${fileId}.preview.pdf`);
}

async function cachedPdf(rel: string, sourceMtimeMs: number): Promise<Buffer | null> {
  try {
    const abs = await resolveStoredPathForRead(rel);
    const st = await stat(abs);
    // A document rewritten since it was converted must be converted again —
    // the whole point of the panel is that it shows the current thing.
    if (st.mtimeMs + 1000 < sourceMtimeMs) return null;
    return await readFile(abs);
  } catch {
    return null;
  }
}

/**
 * The file as a PDF, or null when that cannot be done.
 *
 * `contentPath` is only used to decide where to cache; a file the worker never
 * prepared still converts, it just re-converts each time.
 */
export async function officeAsPdf(input: {
  fileId: string;
  filename: string;
  storagePath: string;
  contentPath: string | null;
}): Promise<Buffer | null> {
  const base = gotenbergUrl();
  if (!base) return null;

  let sourceAbs: string;
  let sourceMtime = 0;
  try {
    sourceAbs = await resolveStoredPathForRead(input.storagePath);
    sourceMtime = (await stat(sourceAbs)).mtimeMs;
  } catch {
    return null;
  }

  const rel = cachePath(input.contentPath, input.fileId);
  if (rel) {
    const hit = await cachedPdf(rel, sourceMtime);
    if (hit) return hit;
  }

  let pdf: Buffer;
  try {
    const bytes = await readFile(sourceAbs);
    const form = new FormData();
    // The NAME matters: LibreOffice picks its filter from the extension, so
    // sending "blob" gets a document it refuses to open.
    form.append("files", new Blob([new Uint8Array(bytes)]), path.basename(input.filename));

    const res = await fetch(`${base}/forms/libreoffice/convert`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      devLog("warn", "files", `Office preview: Gotenberg refused ${input.filename}`, { status: res.status });
      return null;
    }
    pdf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    devLog("warn", "files", `Office preview: Gotenberg unreachable for ${input.filename}`, {
      error: String(e).slice(0, 160),
    });
    return null;
  }

  // Cache it, but never fail the preview because caching failed.
  if (rel) {
    try {
      const abs = path.join(storageRoot(), rel);
      await mkdir(path.dirname(abs), { recursive: true });
      // Temp file + rename, so a half-written PDF is never served to the next
      // reader — the same shape `createBackup` uses for its `.part` file.
      const tmp = `${abs}.part`;
      await writeFile(tmp, pdf);
      await rename(tmp, abs);
    } catch {
      /* read-only pool, or a race with a parallel convert — serve it anyway */
    }
  }

  return pdf;
}
