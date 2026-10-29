"""Windows clipboard listener for ClipCascade.

Event-driven and format-aware. The message pump never reads the clipboard:
clipboard acquisition (which can block while another app owns the clipboard)
happens on a worker thread. Compatible with the upstream on_update/stop API.
"""

import logging
import threading
import time

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
_state_lock = threading.Lock()
_changed = threading.Event()
_stopping = threading.Event()

# Clipboard screenshots may be published as DIB/DIBV5 or a registered image
# format instead of CF_BITMAP. Inspect the content rather than just one format.
_RETRIES = 6
_RETRY_DELAY = 0.075
_SETTLE_DELAY = 0.065


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


def _deliver_clipboard(kind, payload, images, files):
    global _block_image_once
    if kind is None or payload is None:
        return
    if kind == "image":
        if not images:
            return
        with _state_lock:
            suppress = _block_image_once
            _block_image_once = False
        if suppress:
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
        _deliver_clipboard(kind, payload, images, files)


def _process_message(hwnd, msg, wparam, lparam, enable_image_monitoring=False, enable_file_monitoring=False):
    if msg == 0x031D:  # WM_CLIPBOARDUPDATE
        _changed.set()
    elif msg == win32con.WM_CLOSE:
        win32gui.PostQuitMessage(0)
    return 0


def _create_window(images=False, files=False):
    global _hwnd
    class_name = "ClipboardHook"
    wc = win32gui.WNDCLASS()
    wc.lpfnWndProc = lambda hwnd, msg, wparam, lparam: _process_message(
        hwnd, msg, wparam, lparam, images, files
    )
    wc.lpszClassName = class_name
    wc.hInstance = win32api.GetModuleHandle(None)
    atom = win32gui.RegisterClass(wc)
    _hwnd = win32gui.CreateWindow(atom, class_name, 0, 0, 0, 0, 0, wc.hInstance, None)


def _runner(images=False, files=False):
    global _hwnd
    listener_added = False
    try:
        _create_window(images, files)
        import ctypes
        if not ctypes.windll.user32.AddClipboardFormatListener(_hwnd):
            raise OSError("AddClipboardFormatListener failed")
        listener_added = True
        win32gui.PumpMessages()
    except Exception:
        logging.exception("Windows clipboard listener failed")
    finally:
        if _hwnd:
            try:
                if listener_added:
                    import ctypes
                    ctypes.windll.user32.RemoveClipboardFormatListener(_hwnd)
                win32gui.DestroyWindow(_hwnd)
                win32gui.UnregisterClass("ClipboardHook", win32api.GetModuleHandle(None))
            except Exception:
                logging.exception("Windows clipboard listener cleanup failed")
        _hwnd = None


def _start(enable_image_monitoring=False, enable_file_monitoring=False):
    global _clipboard_thread, _worker_thread
    if _clipboard_thread and _clipboard_thread.is_alive():
        return
    _changed.clear()
    _stopping.clear()
    _worker_thread = threading.Thread(
        target=_worker, args=(enable_image_monitoring, enable_file_monitoring),
        name="ClipCascadeClipboardReader", daemon=True
    )
    _clipboard_thread = threading.Thread(
        target=_runner, args=(enable_image_monitoring, enable_file_monitoring),
        name="ClipCascadeClipboardEvents", daemon=True
    )
    _worker_thread.start()
    _clipboard_thread.start()


def stop():
    global _clipboard_thread, _worker_thread, _callback_update, _block_image_once
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
