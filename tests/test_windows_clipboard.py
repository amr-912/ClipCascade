"""Windows clipboard monitor unit tests; Win32 imports are stubbed.

These tests do not replace a real user-session screenshot test on Windows.
"""
import importlib.util
import pathlib
import sys
import types
from unittest.mock import Mock

import pytest
from PIL import Image

SOURCE = pathlib.Path(__file__).parents[1] / "ClipCascade_Desktop/src/clipboard/clipboard_monitor_win.py"


@pytest.fixture
def monitor(monkeypatch):
    api = types.ModuleType("win32api")
    api.GetModuleHandle = lambda _: 123
    con = types.ModuleType("win32con")
    con.CF_BITMAP, con.CF_DIB, con.CF_HDROP = 2, 8, 15
    con.CF_UNICODETEXT, con.CF_TEXT, con.WM_CLOSE = 13, 1, 16
    cb = types.ModuleType("win32clipboard")
    cb.OpenClipboard = Mock()
    cb.CloseClipboard = Mock()
    cb.IsClipboardFormatAvailable = Mock(return_value=False)
    cb.GetClipboardData = Mock(return_value=None)
    gui = types.ModuleType("win32gui")
    gui.WNDCLASS = lambda: types.SimpleNamespace()
    gui.RegisterClass = Mock(return_value=8)
    gui.CreateWindow = Mock(return_value=111)
    gui.PumpMessages = Mock()
    gui.PostMessage = Mock()
    gui.PostQuitMessage = Mock()
    gui.DestroyWindow = Mock()
    gui.UnregisterClass = Mock()
    for name, module in [
        ("win32api", api), ("win32con", con),
        ("win32clipboard", cb), ("win32gui", gui)
    ]:
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location("cc_win_clip_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.ImageGrab, "grabclipboard", Mock(return_value=None))
    return module


def test_dib_screenshot_image_without_explicit_cf_bitmap(monitor):
    img = Image.new("RGB", (24, 12), "blue")
    monitor.ImageGrab.grabclipboard.return_value = img
    kind, result = monitor._get_clipboard_content(True, False)
    assert kind == "image"
    assert result.size == (24, 12)
    monitor.ImageGrab.grabclipboard.assert_called_once()


def test_explorer_image_copy_remains_file(monitor):
    monitor.win32clipboard.IsClipboardFormatAvailable.side_effect = lambda f: f in (15, 13)
    monitor.win32clipboard.GetClipboardData.side_effect = (
        lambda f: ("C:/screenshots/a.png",) if f == 15 else "filename"
    )
    monitor.ImageGrab.grabclipboard.return_value = Image.new("RGB", (1, 1))
    assert monitor._get_clipboard_content(True, True) == (
        "files", ("C:/screenshots/a.png",)
    )
    monitor.ImageGrab.grabclipboard.assert_not_called()


def test_unicode_text(monitor):
    monitor.win32clipboard.IsClipboardFormatAvailable.side_effect = lambda f: f == 13
    monitor.win32clipboard.GetClipboardData.return_value = "مرحبا ClipCascade"
    assert monitor._get_clipboard_content(True, True) == ("text", "مرحبا ClipCascade")
    monitor.win32clipboard.CloseClipboard.assert_called_once()


def test_clipboard_lock_retries_then_succeeds(monitor, monkeypatch):
    calls = {"n": 0}

    def locked_then_ready(images, files):
        calls["n"] += 1
        if calls["n"] < 3:
            raise OSError("clipboard temporarily locked")
        return "text", "ok"

    monkeypatch.setattr(monitor, "_get_clipboard_content", locked_then_ready)
    monkeypatch.setattr(monitor.time, "sleep", lambda _: None)
    assert monitor._read_with_retries(True, True) == ("text", "ok")
    assert calls["n"] == 3


def test_suppress_own_image_echo_once(monitor):
    delivered = []
    monitor._callback_update = lambda typ, img: delivered.append(typ)
    monitor.enable_block_image_once()
    monitor._deliver_clipboard("image", Image.new("RGB", (2, 2)), True, True)
    assert delivered == []
    monitor._deliver_clipboard("image", Image.new("RGB", (2, 2)), True, True)
    assert delivered == ["image"]


def test_disabling_images_keeps_text(monitor):
    delivered = []
    monitor._callback_update = lambda typ, value: delivered.append(typ)
    monitor._deliver_clipboard("image", Image.new("RGB", (2, 2)), False, True)
    monitor._deliver_clipboard("text", "hello", False, True)
    assert delivered == ["text"]


def test_event_handler_does_not_read_clipboard(monitor, monkeypatch):
    monkeypatch.setattr(monitor, "_get_clipboard_content", lambda *_: pytest.fail("read on message-pump thread"))
    monitor._process_message(101, 0x031D, 0, 0)
    assert monitor._changed.is_set()
    monitor._process_message(101, monitor.win32con.WM_CLOSE, 0, 0)
    monitor.win32gui.PostQuitMessage.assert_called_once_with(0)


def test_disabled_image_capture_does_not_call_imagegrab(monitor):
    assert monitor._get_clipboard_content(False, False) == (None, None)
    monitor.ImageGrab.grabclipboard.assert_not_called()


def test_error_in_receiver_callback_does_not_crash_listener(monitor):
    def reject(kind, payload):
        raise RuntimeError("receiver disconnected")
    monitor._callback_update = reject
    monitor._deliver_clipboard("text", "hello", True, True)


def test_disabled_file_transfer_does_not_forward_files(monitor):
    calls = []
    monitor._callback_update = lambda kind, content: calls.append(kind)
    monitor._deliver_clipboard("files", ("C:/file.pdf",), True, False)
    assert calls == []



def test_remote_image_echo_marker_matches_exact_clipboard_sequence(monitor):
    delivered = []
    monitor._callback_update = lambda kind, payload: delivered.append(kind)
    monitor._own_image_sequence = 55
    monitor._block_image_once = False
    img = Image.new("RGB", (2, 2))
    monitor._deliver_clipboard("image", img, True, True, sequence=55)
    assert delivered == []
    monitor._deliver_clipboard("image", img, True, True, sequence=56)
    assert delivered == ["image"]


def test_new_screenshot_never_consumes_stale_remote_image_marker(monitor):
    delivered = []
    monitor._callback_update = lambda kind, payload: delivered.append(kind)
    monitor._own_image_sequence = 55
    monitor._block_image_once = False
    monitor._deliver_clipboard("image", Image.new("RGB", (2, 2)), True, True, sequence=57)
    assert delivered == ["image"]
    assert monitor._own_image_sequence is None
