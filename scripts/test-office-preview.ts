/**
 * Live proof that Word/Excel/PowerPoint preview with their REAL layout
 * (NOT in the test suite — it needs a database, real files and Gotenberg).
 *
 *   node --conditions=react-server --env-file=.env --import tsx scripts/test-office-preview.ts
 *
 * The artifact panel shows an Office file by converting it to PDF through the
 * same LibreOffice container the ingestion worker already uses. Everything here
 * is about that conversion being real and honest:
 *
 *   - it runs against REAL documents out of this instance's own database,
 *     picked by query rather than by name, so the harness has no idea what is
 *     in them and cannot be tuned to one file;
 *   - the result has to actually BE a PDF (magic bytes, page count, size),
 *     because a Gotenberg error page is a perfectly successful HTTP response;
 *   - the cache has to be used the second time AND abandoned when the document
 *     changes — a preview panel that shows a stale document is worse than one
 *     that shows nothing;
 *   - and the NEGATIVE control matters most: with no engine configured the
 *     conversion must return null so the route falls back to the prepared text.
 *     That is the path every instance without Gotenberg takes.
 */
import { stat, utimes, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { officeAsPdf, gotenbergUrl } from "../src/lib/office-preview";
import { resolveStoredPathForRead, storageRoot } from "../src/lib/storage";
import { canPreview, previewKind } from "../src/lib/artifact";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A PDF, judged the way a browser judges one. */
function looksLikePdf(buf: Buffer): { ok: boolean; pages: number } {
  const head = buf.subarray(0, 5).toString("latin1");
  const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return { ok: head === "%PDF-" && buf.length > 1000, pages };
}

function cacheRel(contentPath: string, fileId: string) {
  return path.posix.join(path.posix.dirname(contentPath), `${fileId}.preview.pdf`);
}

async function main() {
  console.log("Office preview (Gotenberg → PDF)\n");

  const base = gotenbergUrl();
  check("the conversion engine is configured", !!base, base ?? "GOTENBERG_URL unset");
  if (!base) {
    console.log("\nSet GOTENBERG_URL (dev: http://localhost:3009) and bring gotenberg up.");
    process.exit(1);
  }

  // Pick real documents out of this instance's own data, by SHAPE not by name:
  // one word processor file and one spreadsheet, smallest first so the run is
  // quick, and only ones the worker finished with (so a cache path exists).
  const pick = async (exts: string[]) =>
    (await db.$queryRawUnsafe<
      { id: string; filename: string; mimeType: string; storagePath: string; contentPath: string }[]
    >(
      `select id, filename, mime_type as "mimeType", storage_path as "storagePath",
              content_path as "contentPath"
         from files
        where status = 'ready' and content_path is not null
          and lower(filename) ~ $1
        order by size_bytes asc
        limit 1`,
      `\\.(${exts.join("|")})$`,
    ))[0];

  const docs = [await pick(["docx", "doc", "odt"]), await pick(["xlsx", "xls", "ods"])].filter(
    Boolean,
  );
  check("found real Office documents to convert", docs.length > 0, `${docs.length} picked`);
  if (docs.length === 0) process.exit(1);

  for (const f of docs) {
    const ext = path.extname(f.filename).toLowerCase();
    console.log(`\n${ext} — ${Math.round((await stat(await resolveStoredPathForRead(f.storagePath))).size / 1024)} KB`);

    // The panel has to OFFER it before any of this matters.
    check(
      `${ext}: previews as "office"`,
      previewKind(f.mimeType, f.filename) === "office",
      previewKind(f.mimeType, f.filename),
    );
    check(
      `${ext}: canPreview says yes with the engine on`,
      canPreview({
        mimeType: f.mimeType,
        filename: f.filename,
        sizeBytes: 100_000,
        hasPrepared: true,
        officeToPdf: true,
      }),
    );

    // Start from cold, or the first assertion proves nothing.
    const rel = cacheRel(f.contentPath, f.id);
    await unlink(path.join(storageRoot(), rel)).catch(() => {});

    const t0 = Date.now();
    const first = await officeAsPdf({
      fileId: f.id,
      filename: f.filename,
      storagePath: f.storagePath,
      contentPath: f.contentPath,
    });
    const coldMs = Date.now() - t0;
    check(`${ext}: converted`, !!first, `${coldMs} ms`);
    if (!first) continue;

    const shape = looksLikePdf(first);
    check(
      `${ext}: the bytes are a real PDF, not an error page`,
      shape.ok,
      `${first.subarray(0, 8).toString("latin1").replace(/[^\x20-\x7e]/g, ".")} · ${Math.round(first.length / 1024)} KB`,
    );
    check(`${ext}: it has at least one laid-out page`, shape.pages >= 1, `${shape.pages} pages`);

    // The layout is the whole point: extracted text has no page boxes. This is
    // the cheapest evidence that LibreOffice really laid it out rather than us
    // wrapping the worker's markdown in a PDF wrapper.
    const body = first.toString("latin1");
    check(
      `${ext}: carries page geometry (MediaBox)`,
      /\/MediaBox\s*\[/.test(body),
      (body.match(/\/MediaBox\s*\[[^\]]*\]/) ?? [""])[0].slice(0, 40),
    );

    const cached = await stat(path.join(storageRoot(), rel));
    check(`${ext}: cached beside the prepared text`, cached.size === first.length, rel.split("/").pop());

    const t1 = Date.now();
    const second = await officeAsPdf({
      fileId: f.id,
      filename: f.filename,
      storagePath: f.storagePath,
      contentPath: f.contentPath,
    });
    const warmMs = Date.now() - t1;
    check(
      `${ext}: the second view is served from cache`,
      !!second && second.equals(first) && warmMs < Math.max(200, coldMs / 3),
      `${warmMs} ms vs ${coldMs} ms cold`,
    );

    // A document the Sandbox rewrote must not keep previewing as the old one.
    const abs = await resolveStoredPathForRead(f.storagePath);
    const now = new Date(Date.now() + 5_000);
    await utimes(abs, now, now);
    const cachedBefore = (await stat(path.join(storageRoot(), rel))).mtimeMs;
    const third = await officeAsPdf({
      fileId: f.id,
      filename: f.filename,
      storagePath: f.storagePath,
      contentPath: f.contentPath,
    });
    const cachedAfter = (await stat(path.join(storageRoot(), rel))).mtimeMs;
    check(
      `${ext}: a newer source re-converts rather than serving the stale PDF`,
      !!third && cachedAfter > cachedBefore,
      `cache rewritten`,
    );
  }

  // ---------------------------------------------------------------- negative
  // Every instance with no Gotenberg takes this path, and it must degrade to
  // the worker's text rather than to a spinner.
  console.log("\nnegative control — no engine configured");
  const saved = process.env.GOTENBERG_URL;
  delete process.env.GOTENBERG_URL;
  const f = docs[0];
  const none = await officeAsPdf({
    fileId: f.id,
    filename: f.filename,
    storagePath: f.storagePath,
    contentPath: f.contentPath,
  });
  check("returns null with no engine, so the route falls back", none === null);
  check(
    "and the panel still offers a preview, from the prepared text",
    canPreview({
      mimeType: f.mimeType,
      filename: f.filename,
      sizeBytes: 100_000,
      hasPrepared: true,
      officeToPdf: false,
    }),
  );
  check(
    "but NOT when there is neither engine nor prepared text",
    !canPreview({
      mimeType: f.mimeType,
      filename: f.filename,
      sizeBytes: 100_000,
      hasPrepared: false,
      officeToPdf: false,
    }),
  );
  const prepared = await readFile(await resolveStoredPathForRead(f.contentPath), "utf8");
  check("the fallback text is real and non-empty", prepared.trim().length > 20, `${prepared.length} chars`);
  process.env.GOTENBERG_URL = saved;

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
