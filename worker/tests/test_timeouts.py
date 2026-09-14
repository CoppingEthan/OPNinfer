"""Engine timeouts must stay inside the reclaim window.

A `processing` row is re-claimed once its claim is older than
WORKER_RECLAIM_MINUTES. Whisper's HTTP timeout was 1800s against a 900s window,
so a long recording — or any file queued behind others on the single shared
whisper container, which serves every instance — was claimed a SECOND time
while the first request was still running. That doubled the load on the engine
that was already the bottleneck, made both requests slower, and ended with the
row marked failed while a transcription was still in flight.

`config.engine_timeout` enforces the relationship instead of leaving it to be
re-broken by hand, so these tests pin the rule rather than the numbers.

    python -m unittest discover worker/tests
"""

import os
import sys
import unittest
from importlib import reload

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


def load_config(reclaim_minutes: str):
    """Import worker.app.config with a given reclaim window."""
    os.environ["WORKER_RECLAIM_MINUTES"] = reclaim_minutes
    os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost:5432/db")
    from worker.app import config as cfg

    return reload(cfg)


class EngineTimeoutTests(unittest.TestCase):
    def test_default_window_leaves_room_for_the_longest_call(self):
        cfg = load_config("35")
        # Whisper asks for 1800s; the window must accommodate it untouched.
        self.assertEqual(cfg.engine_timeout(1800), 1800)

    def test_every_engine_timeout_finishes_before_a_re_claim(self):
        for minutes in ("5", "10", "15", "35", "60"):
            cfg = load_config(minutes)
            window = cfg.RECLAIM_MINUTES * 60
            for preferred in (60, 180, 600, 1800, 7200):
                with self.subTest(minutes=minutes, preferred=preferred):
                    self.assertLess(
                        cfg.engine_timeout(preferred),
                        window,
                        "an engine call may not outlive the claim that owns it",
                    )

    def test_a_short_window_clamps_a_long_call(self):
        cfg = load_config("10")
        self.assertEqual(cfg.engine_timeout(1800), 10 * 60 - 300)

    def test_never_returns_a_uselessly_small_timeout(self):
        cfg = load_config("1")
        self.assertGreaterEqual(cfg.engine_timeout(1800), 60)

    def test_a_short_call_is_left_alone(self):
        cfg = load_config("35")
        self.assertEqual(cfg.engine_timeout(60), 60)


if __name__ == "__main__":
    unittest.main()
