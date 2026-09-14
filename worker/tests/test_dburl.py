"""Unit tests for the Prisma → libpq connection-string fix.

Run from the repo root (no dependencies beyond the standard library):

    python -m unittest discover worker/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.dburl import libpq_url  # noqa: E402


class TestLibpqUrl(unittest.TestCase):
    def test_strips_the_exact_production_url(self) -> None:
        """The URL deploy.sh generates — this is the shape that broke prod."""
        got = libpq_url(
            "postgresql://opninfer:secret@db:5432/opninfer"
            "?schema=public&connection_limit=15&pool_timeout=20"
        )
        self.assertEqual(got, "postgresql://opninfer:secret@db:5432/opninfer")

    def test_leaves_a_bare_url_untouched(self) -> None:
        """The dev-compose shape, which is why this never showed up locally."""
        url = "postgresql://opninfer:opninfer@db:5432/opninfer"
        self.assertEqual(libpq_url(url), url)

    def test_keeps_parameters_libpq_understands(self) -> None:
        got = libpq_url(
            "postgresql://u:p@h:5432/d?sslmode=require&connection_limit=15"
        )
        self.assertEqual(got, "postgresql://u:p@h:5432/d?sslmode=require")

    def test_non_default_schema_becomes_a_search_path(self) -> None:
        got = libpq_url("postgresql://u:p@h:5432/d?schema=tenant_a")
        self.assertEqual(
            # %20, never `+`: libpq only %XX-decodes URI parameters.
            got, "postgresql://u:p@h:5432/d?options=-c%20search_path%3Dtenant_a"
        )

    def test_public_schema_is_dropped_not_translated(self) -> None:
        """`public` is already libpq's default — no options needed."""
        self.assertEqual(
            libpq_url("postgresql://u:p@h:5432/d?schema=public"),
            "postgresql://u:p@h:5432/d",
        )

    def test_existing_options_are_never_overwritten(self) -> None:
        got = libpq_url(
            "postgresql://u:p@h:5432/d?schema=tenant_a&options=-c+statement_timeout%3D5000"
        )
        self.assertIn("statement_timeout", got)
        self.assertNotIn("search_path", got)

    def test_password_with_url_characters_survives(self) -> None:
        url = "postgresql://u:p%40ss%2Fword@h:5432/d?schema=public"
        self.assertEqual(libpq_url(url), "postgresql://u:p%40ss%2Fword@h:5432/d")


if __name__ == "__main__":
    unittest.main()
