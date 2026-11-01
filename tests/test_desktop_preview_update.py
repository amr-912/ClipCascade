import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ClipCascade_Desktop", "src"))

from utils.update_checker import UpdateChecker


def test_fork_preview_never_uses_upstream_update_manifest():
    calls = []
    monitor = UpdateChecker(lambda: calls.append(True))
    monitor.start()
    assert monitor._thread is None
    assert calls == []
    assert monitor.claim_alert(enabled=True) is None
