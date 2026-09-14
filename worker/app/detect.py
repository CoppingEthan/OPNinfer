"""Type detection + routing — the five-group map.

Detection trusts magic bytes over extensions (users mislabel files), but the
extension expresses intent, so routing considers both. The final fallback is
always metadata-only, never an exception.

Groups (see CLAUDE.md "File ingestion"):
  markitdown   — modern Office, PDF-with-text, markup, ebooks, email, zip
  libreoffice  — legacy binary Office/ODF → Gotenberg → PDF → markitdown
  docling      — scanned/complex PDFs (escalated from markitdown)
  spreadsheet  — schema extraction, never a full dump (custom handler)
  database     — schema introspection only (custom handler)
  audio        — Whisper transcript
  video        — ffprobe metadata only
  image        — native model vision at chat time; worker records dimensions
  passthrough  — anything decodable as UTF-8 text (code, config, the long tail)
  metadata     — everything else
"""

import magic

MARKITDOWN_EXTS = {
    "docx", "pptx", "pdf", "html", "htm", "xml", "epub", "msg", "eml", "zip",
    "ipynb", "md", "markdown",
}
LIBREOFFICE_EXTS = {"doc", "ppt", "odt", "odp", "rtf", "pages", "key"}
SPREADSHEET_EXTS = {
    "xlsx", "xlsm", "xls", "ods", "csv", "tsv", "parquet", "avro", "orc",
    "numbers",
}
DATABASE_EXTS = {"db", "sqlite", "sqlite3", "mdb", "accdb"}
AUDIO_EXTS = {
    "mp3", "wav", "m4a", "flac", "ogg", "aac", "wma", "opus", "aiff", "webm",
}
VIDEO_EXTS = {
    "mp4", "mov", "mkv", "avi", "flv", "wmv", "mpeg", "mpg", "m4v", "3gp",
}
IMAGE_EXTS = {
    "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "heic", "heif",
}

MARKITDOWN_MIMES = {
    "application/pdf",
    "text/html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/epub+zip",
}


def ext_of(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot + 1 :].lower() if dot > 0 else ""


def sniff_mime(path: str) -> str:
    try:
        return magic.from_file(path, mime=True) or "application/octet-stream"
    except Exception:
        return "application/octet-stream"


def looks_like_text(path: str, sample_bytes: int = 262_144) -> bool:
    """The catch-all: decodable as UTF-8 (and not binary-ish) → passthrough.

    This one check sweeps the entire long tail of code/config/text formats
    without enumerating them.
    """
    try:
        with open(path, "rb") as f:
            sample = f.read(sample_bytes)
    except OSError:
        return False
    if not sample:
        return True
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        # A multi-byte char may straddle the sample edge — retry a hair short.
        try:
            sample[:-4].decode("utf-8")
            return True
        except UnicodeDecodeError:
            return False


def route(path: str, filename: str, declared_mime: str) -> tuple[str, str]:
    """Return (group, detected_mime) for a stored file."""
    ext = ext_of(filename)
    sniffed = sniff_mime(path)

    # Extension expresses intent — specialist groups first (xlsx sniffs as zip,
    # sqlite as octet-stream: extension is the more useful signal here).
    if ext in SPREADSHEET_EXTS:
        return "spreadsheet", sniffed
    if ext in DATABASE_EXTS:
        return "database", sniffed
    if ext in LIBREOFFICE_EXTS:
        return "libreoffice", sniffed
    if ext in AUDIO_EXTS or sniffed.startswith("audio/"):
        return "audio", sniffed
    if ext in VIDEO_EXTS or sniffed.startswith("video/"):
        return "video", sniffed
    if ext in IMAGE_EXTS or sniffed.startswith("image/"):
        return "image", sniffed
    if ext in MARKITDOWN_EXTS or sniffed in MARKITDOWN_MIMES:
        return "markitdown", sniffed

    # No recognised shape — the UTF-8 sweep, then metadata-only.
    if sniffed.startswith("text/") or looks_like_text(path):
        return "passthrough", sniffed
    return "metadata", sniffed
