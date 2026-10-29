"""Real Windows clipboard integration tests.

Unlike the Win32 API stubs in test_windows_clipboard.py, these tests register
an actual hidden window, subscribe to Windows clipboard notifications, and
write CF_UNICODETEXT / CF_DIB through the real Win32 clipboard API. They catch
invalid win32gui.CreateWindow arguments that formerly went unnoticed.
"""
import importlib.util
import io
import pathlib
import sys
import threading
import time
import uuid

import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="requires real Windows user32 clipboard APIs")
SOURCE = pathlib.Path(__file__).resolve().parents[1] / "ClipCascade_Desktop/src/clipboard/clipboard_monitor_win.py"


@pytest.fixture
def monitor():
    import win32clipboard  # real pywin32, NOT the stubs used by unit tests
    import win32con

    spec = importlib.util.spec_from_file_location("cc_clipboard_live_win", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        yield module
    finally:
        module.stop()


def _write_clipboard(kind, value):
    import win32clipboard
    import win32con
    for attempt in range(10):
        try:
            win32clipboard.OpenClipboard()
            break
        except Exception:
            time.sleep(0.05)
    else:
        raise AssertionError("Real Windows clipboard unavailable on CI host")
    try:
        win32clipboard.EmptyClipboard()
        if kind == "text":
            win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, value)
        else:
            win32clipboard.SetClipboardData(win32con.CF_DIB, value)
    finally:
        win32clipboard.CloseClipboard()


def test_real_windows_listener_receives_unicode_clipboard_updates(monitor):
    signal = threading.Event()
    value = "CC-WIN32-CLIPBOARD-SMOKE-" + str(uuid.uuid4())
    captured = []

    def callback(kind, payload):
        captured.append((kind, payload))
        if kind == "text" and payload == value:
            signal.set()

    monitor.on_update(callback, enable_image_monitoring=True, enable_file_monitoring=True)
    assert monitor._hwnd, "Real Win32 CreateWindow() must return a handle"
    assert monitor._listener_ready.is_set()
    assert monitor._clipboard_thread.is_alive()
    _write_clipboard("text", value)
    assert signal.wait(timeout=8), f"WM_CLIPBOARDUPDATE not delivered; captured types: {[x[0] for x in captured]}"


def test_real_windows_listener_receives_dib_image_screenshot(monitor):
    signal = threading.Event()
    captured = []
    expected = Image.new("RGB", (19, 13), (7, 55, 140))
    buffer = io.BytesIO()
    expected.save(buffer, format="BMP")
    raw_dib = buffer.getvalue()[14:]  # Windows CF_DIB excludes BMP file header

    def callback(kind, payload):
        captured.append(kind)
        if kind == "image" and payload.size == expected.size:
            signal.set()

    monitor.on_update(callback, enable_image_monitoring=True, enable_file_monitoring=True)
    assert monitor._listener_ready.is_set()
    _write_clipboard("dib", raw_dib)
    assert signal.wait(timeout=8), f"CF_DIB screenshot not decoded; types: {captured}"
