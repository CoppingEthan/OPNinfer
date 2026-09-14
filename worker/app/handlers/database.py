"""Group 4 — database files: schema introspection ONLY (tables, columns,
types, foreign keys, row counts). Never the contents — the model writes
queries against the stored file instead of ingesting rows."""

import sqlite3
from urllib.parse import quote

from ..detect import ext_of
from ..result import HandlerResult

SQLITE_EXTS = {"db", "sqlite", "sqlite3"}


def _sqlite(path: str, filename: str) -> HandlerResult:
    # Read-only + immutable: never mutate a user's file, tolerate missing WAL.
    # Percent-encode the path: a `#` or `%` in the filename would otherwise be
    # parsed as a fragment/escape and open a DIFFERENT file (audit 2026-09-05).
    uri = f"file:{quote(path)}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        tables = [r[0] for r in cur.fetchall()]

        sections: list[str] = []
        table_metas: list[dict] = []
        for t in tables:
            quoted = t.replace('"', '""')
            cur.execute(f'PRAGMA table_info("{quoted}")')
            cols = cur.fetchall()  # cid, name, type, notnull, default, pk
            cur.execute(f'PRAGMA foreign_key_list("{quoted}")')
            fks = cur.fetchall()
            try:
                cur.execute(f'SELECT COUNT(*) FROM "{quoted}"')
                count = cur.fetchone()[0]
            except sqlite3.Error:
                count = None

            col_lines = "\n".join(
                f"- `{c[1]}` {c[2] or 'ANY'}"
                + (" PRIMARY KEY" if c[5] else "")
                + (" NOT NULL" if c[3] else "")
                for c in cols
            )
            fk_lines = "".join(
                f"\n- FK `{fk[3]}` → `{fk[2]}`.`{fk[4]}`" for fk in fks
            )
            rows_str = f"{count:,} rows" if count is not None else "row count unavailable"
            sections.append(f"## {t} — {rows_str}\n{col_lines}{fk_lines}")
            table_metas.append({"name": t, "rows": count, "columns": len(cols)})

        content = (
            f"# {filename} — SQLite schema ({len(tables)} table"
            f"{'s' if len(tables) != 1 else ''})\n\n" + "\n\n".join(sections) + "\n\n"
            "_Schema only; query the stored file for data._"
        )
        return HandlerResult(
            status="ready",
            processor_group="database",
            content=content,
            meta={"engine": "sqlite", "tables": table_metas},
        )
    finally:
        conn.close()


def handle(path: str, filename: str, job: object) -> HandlerResult:
    ext = ext_of(filename)
    if ext in SQLITE_EXTS:
        try:
            return _sqlite(path, filename)
        except sqlite3.DatabaseError:
            # .db is a generic extension — not actually SQLite.
            return HandlerResult(
                status="unsupported",
                processor_group="database",
                meta={"note": "Not a SQLite database; stored as-is."},
            )
        except Exception as e:  # noqa: BLE001
            return HandlerResult(
                status="failed", processor_group="database",
                error=f"{type(e).__name__}: {e}",
            )
    # Access (.mdb/.accdb) — no driver in the container; honest metadata.
    return HandlerResult(
        status="unsupported",
        processor_group="database",
        meta={"note": f"No introspection driver for .{ext}; stored and addressable by path."},
    )
