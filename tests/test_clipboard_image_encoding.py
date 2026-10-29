"""Regression tests using the actual production image serialization methods.

Isolated via AST to avoid importing Windows-only process/GUI dependencies on
Linux CI; methods are executed verbatim, not reimplemented or mocked.
"""
import ast
import base64
import io
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1] / "ClipCascade_Desktop/src/clipboard/clipboard_manager.py"


def get_production_methods():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ClipboardManager")
    wanted = {"_image_as_png_bytes", "get_image_size", "convert_image_to_base64"}
    methods = [n for n in original.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
    assert {n.name for n in methods} == wanted
    isolated = ast.Module(body=[ast.ClassDef(
        name="ClipboardManager", bases=[], keywords=[], body=methods,
        decorator_list=[]
    )], type_ignores=[])
    ast.fix_missing_locations(isolated)
    env = {"Image": Image, "io": io, "base64": base64}
    exec(compile(isolated, str(SOURCE), "exec"), env)
    return env["ClipboardManager"]


def test_windows_dib_screenshot_is_encoded_as_full_png_file():
    mgr = get_production_methods()
    screenshot = Image.new("RGB", (27, 13), (12, 85, 191))
    raw_dib = io.BytesIO()
    screenshot.save(raw_dib, format="DIB")
    with Image.open(io.BytesIO(raw_dib.getvalue())) as clipboard_image:
        assert clipboard_image.format == "DIB"
        encoded = mgr.convert_image_to_base64(clipboard_image)
        result = base64.b64decode(encoded)
        assert result.startswith(b"\\x89PNG\\r\\n\\x1a\\n")
        assert mgr.get_image_size(clipboard_image) == len(result)
        with Image.open(io.BytesIO(result)) as decoded:
            assert decoded.format == "PNG"
            assert decoded.size == (27, 13)
            assert decoded.getpixel((0, 0)) == (12, 85, 191)


def test_image_bytes_from_dib_are_also_normalized_to_png():
    mgr = get_production_methods()
    screenshot = Image.new("RGB", (9, 9), "green")
    dib = io.BytesIO()
    screenshot.save(dib, format="DIB")
    normalized = base64.b64decode(mgr.convert_image_to_base64(dib.getvalue()))
    assert normalized[:8] == bytes.fromhex("89504e470d0a1a0a")
    assert mgr.get_image_size(dib.getvalue()) == len(normalized)


def test_png_preserves_transparency_and_dimensions():
    mgr = get_production_methods()
    img = Image.new("RGBA", (11, 7), (255, 1, 2, 48))
    encoded = base64.b64decode(mgr.convert_image_to_base64(img))
    with Image.open(io.BytesIO(encoded)) as decoded:
        assert decoded.mode == "RGBA"
        assert decoded.size == (11, 7)
        assert decoded.getpixel((0, 0)) == (255, 1, 2, 48)


def test_non_png_image_modes_convert_to_valid_png():
    mgr = get_production_methods()
    img = Image.new("CMYK", (5, 5), (0, 50, 100, 10))
    encoded = base64.b64decode(mgr.convert_image_to_base64(img))
    with Image.open(io.BytesIO(encoded)) as decoded:
        assert decoded.format == "PNG"
        assert decoded.mode == "RGB"
