"""Windows clipboard listener for ClipCascade.

Event-driven and format-aware. The message pump never reads the clipboard:
clipboard acquisition (which can block while another app owns the clipboard)
happens on a worker thread. Compatible with the upstream on_update/stop API.
"""

import logging
import threading
import time
import ctypes
from ctypes import wintypes

import win32api
import win32con
import win32clipboard
import win32gui
from PIL import Image, ImageGrab

_clipboard_thread = None
_worker_thread = None
_hwnd = None
_callback_update = None
_block_image_once = False
_own_image_sequence = None  # sequence number of an image written by ClipCascade
_state_lock = threading.Lock()
_changed = threading.Event()
_stopping = threading.Event()
_listener_ready = threading.Event()
_listener_failure = None
_class_registered = False

# Clipboard screenshots may be published as DIB/DIBV5 or a registered image
# format instead of CF_BITMAP. Inspect the content rather than just one format.
_RETRIES = 6
_RETRY_DELAY = 0.075
_SETTLE_DELAY = 0.065


def _clipboard_sequence():
    """Win32 sequence number changes on each clipboard write, including screenshots."""
    try:
        value = ctypes.windll.user32.GetClipboardSequenceNumber()
        return int(value) if value else None
    except (AttributeError, OSError):
        return None


def _get_clipboard_content(enable_image_monitoring=False, enable_file_monitoring=False):
    """Return (kind, content) for text, in-memory images, and Explorer files.

    Explorer CF_HDROP copies stay files, not implicitly converted to images.
    Nothing in this method changes the clipboard.
    """
    if enable_file_monitoring and win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP):
        win32clipboard.OpenClipboard()
        try:
            files = win32clipboard.GetClipboardData(win32con.CF_HDROP)
        finally:
            win32clipboard.CloseClipboard()
        if files:
            return "files", files

    if enable_image_monitoring:
        # Pillow decodes actual Windows bitmap/DIB clipboard images, and may
        # return a list of file paths when the clipboard contains CF_HDROP.
        grabbed = ImageGrab.grabclipboard()
        if grabbed is None and any(
            win32clipboard.IsClipboardFormatAvailable(fmt)
            for fmt in (win32con.CF_BITMAP, win32con.CF_DIB, getattr(win32con, "CF_DIBV5", 17))
        ):
            logging.warning("Clipboard has Windows bitmap data but Pillow could not decode it")
        if isinstance(grabbed, Image.Image):
            grabbed.load()  # detach from clipboard owner before returning
            return "image", grabbed
        if enable_file_monitoring and isinstance(grabbed, (list, tuple)) and grabbed:
            return "files", grabbed

    win32clipboard.OpenClipboard()
    try:
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
            return "text", win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_TEXT):
            raw = win32clipboard.GetClipboardData(win32con.CF_TEXT)
            return "text", raw.decode(errors="replace") if isinstance(raw, bytes) else raw
    finally:
        win32clipboard.CloseClipboard()
    return None, None


def _read_with_retries(images, files):
    for attempt in range(_RETRIES):
        if _stopping.is_set():
            return None, None
        try:
            return _get_clipboard_content(images, files)
        except Exception as exc:
            if attempt == _RETRIES - 1:
                logging.warning("Clipboard temporarily unavailable after %d tries: %s", _RETRIES, exc)
                return None, None
            time.sleep(_RETRY_DELAY * (attempt + 1))
    return None, None


def _deliver_clipboard(kind, payload, images, files, sequence=None):
    global _block_image_once, _own_image_sequence
    if kind is None or payload is None:
        return
    if kind == "image":
        if not images:
            return
        with _state_lock:
            if _own_image_sequence is not None:
                suppress = sequence == _own_image_sequence
                # A new user screenshot has a NEW sequence number: never
                # discard it just because an old remote-image marker remains.
                _own_image_sequence = None
                _block_image_once = False
            else:
                suppress = _block_image_once
                _block_image_once = False
        if suppress:
            logging.info("Skipped ClipCascade-owned clipboard image echo")
            return
    elif kind == "files" and not files:
        return
    elif kind not in ("text", "image", "files"):
        return
    if _callback_update and not _stopping.is_set():
        try:
            _callback_update(kind, payload)
        except Exception:
            logging.exception("Error processing clipboard update")


def _worker(images, files):
    while not _stopping.is_set():
        if not _changed.wait(timeout=0.5):
            continue
        _changed.clear()
        if _stopping.is_set():
            break
        # One copy can emit several clipboard-format update notifications.
        time.sleep(_SETTLE_DELAY)
        kind, payload = _read_with_retries(images, files)
        _deliver_clipboard(kind, payload, images, files, sequence=_clipboard_sequence())


def _process_message(hwnd, msg, wparam, lparam, enable_image_monitoring=False, enable_file_monitoring=False):
    if msg == 0x031D:  # WM_CLIPBOARDUPDATE
        _changed.set()
    elif msg == win32con.WM_CLOSE:
        win32gui.PostQuitMessage(0)
    return 0


def _create_window(images=False, files=False):
    """Create a real, hidden Win32 window to receive WM_CLIPBOARDUPDATE.

    win32gui.CreateWindow REQUIRES 11 arguments: class, title, style,
    x, y, width, height, parent, menu, hInstance, reserved. The old
    preview provided only nine, so the listener never started.
    """
    global _hwnd, _class_registered
    class_name = "ClipCascadeClipboardHook"
    wc = win32gui.WNDCLASS()
    wc.lpfnWndProc = lambda hwnd, msg, wparam, lparam: _process_message(
        hwnd, msg, wparam, lparam, images, files
    )
    wc.lpszClassName = class_name
    wc.hInstance = win32api.GetModuleHandle(None)
    win32gui.RegisterClass(wc)
    _class_registered = True
    _hwnd = win32gui.CreateWindow(
        class_name, class_name,
        0,                      # hidden top-level window: no visual changes
        0, 0, 0, 0,            # x, y, width, height
        0, 0,                  # parent, menu
        wc.hInstance, None,    # module handle, reserved
    )
    if not _hwnd:
        raise RuntimeError("Win32 clipboard window returned an empty handle")


def _set_clipboard_listener(hwnd, add=True):
    """Win32 HWND is pointer-sized; declare ctypes types explicitly on x64."""
    api = ctypes.windll.user32
    fn = api.AddClipboardFormatListener if add else api.RemoveClipboardFormatListener
    fn.argtypes = [wintypes.HWND]
    fn.restype = wintypes.BOOL
    if not fn(hwnd):
        raise ctypes.WinError()


def _runner(images=False, files=False):
    global _hwnd, _class_registered, _listener_failure
    listener_added = False
    try:
        _create_window(images, files)
        _set_clipboard_listener(_hwnd, add=True)
        listener_added = True
        logging.info("Windows clipboard listener ready (HWND=%s)", _hwnd)
        _listener_ready.set()
        win32gui.PumpMessages()
    except Exception as exc:
        _listener_failure = exc
        logging.exception("Windows clipboard listener failed")
        _stopping.set()
        _changed.set()
        _listener_ready.set()
    finally:
        # Always unregister even when window construction failed halfway.
        try:
            if _hwnd and listener_added:
                _set_clipboard_listener(_hwnd, add=False)
        except Exception:
            logging.exception("Failed to remove clipboard listener")
        try:
            if _hwnd:
                win32gui.DestroyWindow(_hwnd)
        except Exception:
            logging.exception("Failed to destroy clipboard listener window")
        try:
            if _class_registered:
                win32gui.UnregisterClass("ClipCascadeClipboardHook", win32api.GetModuleHandle(None))
        except Exception:
            logging.exception("Failed to unregister clipboard window class")
        finally:
            _hwnd = None
            _class_registered = False
            _listener_ready.set()


def _start(enable_image_monitoring=False, enable_file_monitoring=False):
    global _clipboard_thread, _worker_thread, _listener_failure
    if _clipboard_thread and _clipboard_thread.is_alive():
        return
    _changed.clear()
    _stopping.clear()
    _listener_ready.clear()
    _listener_failure = None
    _clipboard_thread = threading.Thread(
        target=_runner, args=(enable_image_monitoring, enable_file_monitoring),
        name="ClipCascadeClipboardEvents", daemon=True
    )
    _clipboard_thread.start()
    # Surface listener failure instead of showing Connected while clipboard
    # monitoring is completely nonfunctional.
    if not _listener_ready.wait(timeout=8.0):
        _stopping.set()
        logging.error("Windows clipboard listener did not become ready")
        raise RuntimeError("Windows clipboard listener startup timed out")
    if _listener_failure is not None or _stopping.is_set():
        raise RuntimeError("Windows clipboard listener startup failed") from _listener_failure

    _worker_thread = threading.Thread(
        target=_worker, args=(enable_image_monitoring, enable_file_monitoring),
        name="ClipCascadeClipboardReader", daemon=True
    )
    _worker_thread.start()


def stop():
    global _clipboard_thread, _worker_thread, _callback_update, _block_image_once, _own_image_sequence
    _stopping.set()
    _changed.set()
    if _hwnd:
        try:
            win32gui.PostMessage(_hwnd, win32con.WM_CLOSE, 0, 0)
        except Exception:
            logging.exception("Failed to notify clipboard listener to stop")
    if _clipboard_thread and _clipboard_thread is not threading.current_thread():
        _clipboard_thread.join(timeout=3)
    if _worker_thread and _worker_thread is not threading.current_thread():
        _worker_thread.join(timeout=3)
    _clipboard_thread = None
    _worker_thread = None
    _callback_update = None
    with _state_lock:
        _block_image_once = False
        _own_image_sequence = None
    logging.info("Clipboard monitor stopped")


def wait():
    if _clipboard_thread:
        _clipboard_thread.join()


def enable_block_image_once():
    global _block_image_once
    with _state_lock:
        _block_image_once = True


def on_update(callback, enable_image_monitoring=False, enable_file_monitoring=False):
    global _callback_update
    _callback_update = callback
    _start(enable_image_monitoring, enable_file_monitoring)

def mark_own_image_written():
    """Tag the exact clipboard version written by ClipCascade after SetClipboardData."""
    global _block_image_once, _own_image_sequence
    seq = _clipboard_sequence()
    with _state_lock:
        _own_image_sequence = seq
        _block_image_once = seq is None  # fallback on systems without sequence support
