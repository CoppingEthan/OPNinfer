"""Make Prisma's DATABASE_URL usable by libpq (psycopg).

The app and the worker share ONE `DATABASE_URL`: deploy.sh generates it with
Prisma's pool tuning on the end (`?schema=public&connection_limit=15&
pool_timeout=20`). Prisma understands those; libpq does not, and rejects the
whole connection with `invalid URI query parameter: "schema"`.

Found in production (2026-07-29): the worker had never connected once in 8
days — every upload would have sat `pending` forever — while the app, which is
Prisma, was perfectly healthy. Local dev never saw it because
docker-compose.dev.yml hands the worker a bare URL with no query string.

Pure module (no environment, no imports from the rest of the worker) so it can
be unit-tested on its own: `python -m unittest discover worker/tests`.
"""

from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

#: Query parameters Prisma accepts that are not valid libpq keywords.
PRISMA_ONLY_PARAMS = frozenset(
    {
        "schema",
        "connection_limit",
        "pool_timeout",
        "socket_timeout",
        "pgbouncer",
        "statement_cache_size",
        "sslidentity",
        "sslpassword",
        "sslcert",
    }
)


def libpq_url(url: str) -> str:
    """Return `url` with Prisma-only query parameters removed.

    A non-default `schema` is carried over as libpq's own
    `options=-c search_path=<schema>` so the worker still reads the right
    tables. Anything libpq understands (sslmode, application_name, …) is left
    untouched, and a URL with no query string is returned unchanged.
    """
    parts = urlsplit(url)
    if not parts.query:
        return url

    kept: list[tuple[str, str]] = []
    schema: str | None = None
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered == "schema":
            schema = value
        elif lowered in PRISMA_ONLY_PARAMS:
            continue
        else:
            kept.append((key, value))

    # `public` is already libpq's default search_path, so only a non-default
    # schema needs carrying over — and never on top of an explicit `options`.
    has_options = any(k.lower() == "options" for k, _ in kept)
    if schema and schema != "public" and not has_options:
        kept.append(("options", f"-c search_path={schema}"))

    # `quote_via=quote`: libpq only %XX-decodes a URI, so the default
    # `quote_plus` would send `options=-c+search_path=…` with a literal `+`
    # the server rejects — the "worker never connects" outage this module
    # exists to prevent, recreated the day anyone sets a tenant schema
    # (audit 2026-09-05).
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(kept, quote_via=quote), parts.fragment)
    )
