import base64
import io
import json
import logging
import os
import xxhash


from PIL import Image
from core.constants import *
from core.config import Config

if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel

if PLATFORM == WINDOWS or PLATFORM == MACOS:
    import pyperclip


if PLATFORM == WINDOWS:
    import win32clipboard
    from clipboard import clipboard_monitor_win as clipboard_monitor
elif PLATFORM == MACOS:
    import pasteboard
    from clipboard import clipboard_monitor_mac as clipboard_monitor
elif PLATFORM.startswith(LINUX):
    from clipboard import clipboard_monitor_linux as clipboard_monitor
    import subprocess


class ClipboardManager:
    def __init__(self, config: Config):
        self.config = config
        self.previous_clipboard_hash = 0
        self.sys_tray: TaskbarPanel = None
        self.is_files_download_enabled = False

        if PLATFORM.startswith(LINUX) and XMODE:
            self.is_x_clipboard_owner = clipboard_monitor.is_x_clipboard_owner()

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray

    def reset_files_download(self):
        """
        Resets the files download flag and disables the download functionality in the system tray if enabled.
        """
        if self.is_files_download_enabled:
            self.is_files_download_enabled = False
            if self.sys_tray:
                self.sys_tray.disable_files_download()

    @staticmethod
    def hash_clipboard(clipboard: str) -> int:
        return xxhash.xxh64(clipboard.encode("utf-8") if isinstance(clipboard, str) else clipboard).intdigest()

    def is_clipboard_size_within_limit(
        self, clipboard_content: any, type_: str = "text"
    ) -> bool:
        if clipboard_content is None:
            raise ValueError("Clipboard content cannot be None")

        content_size_in_bytes = None
        if type_ == "text":
            content_size_in_bytes = len(clipboard_content.encode("utf-8"))
        elif type_ == "image":
            content_size_in_bytes = ClipboardManager.get_image_size(
                img=clipboard_content
            )
        elif type_ == "files":
            content_size_in_bytes = ClipboardManager.calculate_cumulative_file_size(
                files=clipboard_content
            )

        # Check if the content size exceeds the server limit
        max_allowed_size = self.config.data["maxsize"]
        if (
            max_allowed_size is not None
            and max_allowed_size >= 0
            and content_size_in_bytes > max_allowed_size
        ):
            logging.warning(
                "Clipboard content size exceeds the maximum allowed limit. "
                f"Allowed: {max_allowed_size} bytes, Found: {content_size_in_bytes} bytes."
            )
            return False

        # Check if the content size exceeds the local limit
        local_clipboard_size_limit = self.config.data[
            "max_clipboard_size_local_limit_bytes"
        ]
        if local_clipboard_size_limit is not None and local_clipboard_size_limit >= 0:
            if content_size_in_bytes > local_clipboard_size_limit:
                logging.warning(
                    "Clipboard content size exceeds the local allowed limit. "
                    f"Allowed: {local_clipboard_size_limit} bytes, Found: {content_size_in_bytes} bytes."
                )
                return False

        return True

    def has_clipboard_changed(self, payload: str) -> bool:
        """
        Check if the clipboard content has changed by comparing the current hash
        with the previous clipboard hash.

        Parameters:
        - payload: The current clipboard content.

        Returns:
        - True if the clipboard content has changed, False otherwise.
        """
        current_clipboard_hash = ClipboardManager.hash_clipboard(payload)
        if current_clipboard_hash != self.previous_clipboard_hash:
            self.previous_clipboard_hash = current_clipboard_hash
            return True
        return False

    def on_copy(self, copy_callback):
        clipboard_monitor.on_update(
            callback=lambda type_, content: self.clipboard_to_base64(
                copy_callback, content, type_
            ),
            enable_image_monitoring=self.config.data["enable_image_sharing"],
            enable_file_monitoring=self.config.data["enable_file_sharing"],
        )

    def clipboard_to_base64(self, callback, content: any, type_: str = "text"):
        try:
            self.reset_files_download()

            type_ = type_.lower()
            if type_ == "text":
                if self.is_clipboard_size_within_limit(content, type_):
                    callback(content, type_)

            elif type_ == "image":
                if isinstance(content, Image.Image):
                    logging.info(
                        "Windows clipboard image detected: %sx%s, source format=%s",
                        content.width, content.height, content.format or "in-memory"
                    )
                if isinstance(content, list):
                    if content is None or len(content) == 0:
                        raise ValueError(
                            "Clipboard image content cannot be None or empty"
                        )

                    content = Image.open(content[0])
                if self.is_clipboard_size_within_limit(content, type_):
                    content_str = ClipboardManager.convert_image_to_base64(img=content)
                    logging.info("Clipboard image encoded as PNG: %d base64 bytes", len(content_str))
                    callback(content_str, type_)

            elif type_ == "files":
                if PLATFORM.startswith(LINUX):
                    if content is not None and len(content) > 0:
                        temp = []
                        for path in content:
                            if path.startswith("file:"):
                                temp.append(path[5:])
                            else:
                                temp.append(path)
                        content = temp

                if self.is_clipboard_size_within_limit(content, type_):
                    content_str = ClipboardManager.convert_files_to_base64(
                        file_paths=content
                    )
                    if content_str != "{}":  # Check if the JSON string is empty
                        callback(content_str, type_)
        except Exception as e:
            logging.error(f"Failed to convert clipboard data to base64: {e}")

    def base64_to_clipboard(self, base64_string: str, type_: str = "text"):
        try:
            if type_ == "text":
                txt = base64_string
                if self.is_clipboard_size_within_limit(txt, type_):
                    self.paste(txt, type_)
            elif type_ == "image":
                img = ClipboardManager.convert_base64_to_image(base64_img=base64_string)
                if self.is_clipboard_size_within_limit(img, type_):
                    self.paste(img, type_)
            elif type_ == "files":
                file_objects = ClipboardManager.convert_base64_to_files(
                    base64_json=base64_string
                )
                if self.is_clipboard_size_within_limit(file_objects, type_):
                    self.paste(file_objects, type_)
        except Exception as e:
            logging.error(f"Failed to convert base64 data to clipboard: {e}")

    @staticmethod
    def execute_command(*args, input_data):
        """
        Execute a command with input data.

        Parameters:
        - *args: Positional arguments for the command.
        - input_data: Input data to be passed to the command.
        """
        if PLATFORM.startswith(LINUX):
            try:
                subprocess.run(
                    args,
                    input=input_data,
                    check=True,
                )
            except Exception as e:
                logging.error(f"Failed to execute command: {e}")
                raise

    def paste(self, payload: any, payload_type: str = "text"):
        try:
            self.reset_files_download()

            if payload_type == "text":
                if PLATFORM == MACOS:
                    clipboard_monitor.write_to_pasteboard(payload, pasteboard.String)
                elif PLATFORM == WINDOWS:
                    pyperclip.copy(payload)
                elif PLATFORM.startswith(LINUX):
                    if XMODE and self.is_x_clipboard_owner:
                        ClipboardManager.execute_command(
                            "xclip",
                            "-selection",
                            "clipboard",
                            input_data=payload.encode("utf-8"),
                        )
                    else:
                        ClipboardManager.execute_command(
                            "wl-copy",
                            input_data=payload.encode("utf-8"),
                        )

            elif payload_type == "image":
                if PLATFORM == WINDOWS:
                    # Save the image to a binary buffer in BMP format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="BMP")
                        bmp_data = output.getvalue()[14:]  # Skip BMP header (14 bytes)

                    win32clipboard.OpenClipboard()
                    wrote_image = False
                    try:
                        win32clipboard.EmptyClipboard()
                        win32clipboard.SetClipboardData(win32clipboard.CF_DIB, bmp_data)
                        wrote_image = True
                    finally:
                        win32clipboard.CloseClipboard()
                    if wrote_image:
                        # Suppress only THIS write, not the next real user screenshot.
                        clipboard_monitor.mark_own_image_written()
                elif PLATFORM == MACOS:
                    # Save the image to a binary buffer in TIFF format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="TIFF")
                        tiff_data = output.getvalue()

                    clipboard_monitor.enable_block_image_once()  # Block image copy to prevent deadlock
                    clipboard_monitor.write_to_pasteboard(tiff_data, pasteboard.TIFF)
                elif PLATFORM.startswith(LINUX):
                    # Save the image to a binary buffer in PNG format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="PNG")
                        png_data = output.getvalue()

                    clipboard_monitor.enable_block_image_once()  # Block image copy to prevent deadlock
                    if XMODE and self.is_x_clipboard_owner:
                        ClipboardManager.execute_command(
                            "xclip",
                            "-selection",
                            "clipboard",
                            "-t",
                            "image/png",
                            input_data=png_data,
                        )
                    else:
                        ClipboardManager.execute_command(
                            "wl-copy",
                            "--type",
                            "image/png",
                            input_data=png_data,
                        )

            elif payload_type == "files":
                if (
                    payload is not None
                    and isinstance(payload, dict)
                    and len(payload) > 0
                ):
                    if self.sys_tray is not None:
                        self.is_files_download_enabled = True
                        self.sys_tray.enable_files_download(files=payload)

        except Exception as e:
            logging.error(f"Failed to copy data to clipboard: {e}")
            raise

    def stop(self):
        self.reset_files_download()
        clipboard_monitor.stop()

    @staticmethod
    def calculate_cumulative_file_size(files: tuple | list | dict) -> int:
        """
        Calculate the cumulative size of a list of files.

        Args:
            files (tuple or list): A tuple of file paths.
            files (dict): A dictionary of files with file names as keys and file object as values.

        Returns:
            int: The cumulative size of the files in bytes.

        Raises:
            IOError: If a file cannot be read or processed.
        """
        cumulative_size = 0
        if isinstance(files, tuple | list):
            for file_path in files:
                try:
                    if os.path.isfile(file_path):
                        cumulative_size += os.path.getsize(file_path)
                except Exception as e:
                    raise IOError(
                        f"Failed to calculate size for file '{file_path}' {e}."
                    ) from e

        if isinstance(files, dict):
            for file_name, file_object in files.items():
                try:
                    cumulative_size += file_object.getbuffer().nbytes
                except Exception as e:
                    raise IOError(
                        f"Failed to calculate size for file '{file_name}' {e}."
                    ) from e

        return cumulative_size

    @staticmethod
    def convert_files_to_base64(file_paths: tuple | list) -> str:
        """
        Converts a list of files to base64-encoded strings and returns them as a JSON string.

        Args:
            file_paths (tuple or list): A tuple of file paths to be converted.

        Returns:
            str: A JSON string where file names are keys and base64-encoded content is values.

        Raises:
            IOError: If a file cannot be read or processed.
        """
        base64_encoded_files = {}
        for file_path in file_paths:
            try:
                if os.path.isfile(file_path):
                    file_name = os.path.basename(file_path)
                    with open(file_path, "rb") as file:
                        encoded_string = base64.b64encode(file.read()).decode("utf-8")
                        base64_encoded_files[file_name] = encoded_string
            except Exception as e:
                raise IOError(f"Failed to process file '{file_path}'. {e}") from e

        return json.dumps(base64_encoded_files)

    @staticmethod
    def convert_base64_to_files(base64_json: dict) -> dict:
        """
        Converts a JSON string with base64-encoded file content to a dictionary of file-like objects.

        Args:
            base64_json (str): A JSON string where file names are keys and base64-encoded content is values.

        Returns:
            dict: A dictionary where keys are file names, and values are BytesIO objects containing the decoded file data.
        """
        file_objects = {}
        try:
            base64_data = json.loads(base64_json)
            for file_name, encoded_content in base64_data.items():
                decoded_content = base64.b64decode(encoded_content)
                file_objects[file_name] = io.BytesIO(decoded_content)
        except Exception as e:
            raise IOError(f"Error processing base64 JSON. {e}") from e

        return file_objects

    @staticmethod
    def _image_as_png_bytes(img: Image.Image | bytes) -> bytes:
        """Normalize all clipboard pictures to a valid PNG file.

        Windows screenshot/CF_DIB images often come back from Pillow with
        img.format == "DIB". Raw DIB is NOT a PNG or complete BMP file and
        may not be decoded by Android BitmapFactory. The transmitted format
        must be independent of the source clipboard representation.
        """
        if isinstance(img, (bytes, bytearray)):
            with Image.open(io.BytesIO(img)) as source:
                source.load()
                return ClipboardManager._image_as_png_bytes(source)
        if not isinstance(img, Image.Image):
            raise TypeError("Clipboard image must be a Pillow image or encoded image bytes")

        # Keep supported alpha/palette modes; convert unusual modes to RGB/RGBA.
        if img.mode not in ("1", "L", "LA", "P", "RGB", "RGBA", "I", "I;16"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        with io.BytesIO() as buffer:
            img.save(buffer, format="PNG")
            return buffer.getvalue()

    @staticmethod
    def get_image_size(img: Image.Image | bytes) -> int:
        """Return size of the actual PNG representation sent to Android."""
        return len(ClipboardManager._image_as_png_bytes(img))

    @staticmethod
    def convert_image_to_base64(img: Image.Image | bytes) -> str:
        """Encode a complete PNG file, never a Windows raw DIB bitmap."""
        return base64.b64encode(ClipboardManager._image_as_png_bytes(img)).decode("ascii")

    @staticmethod
    def convert_base64_to_image(base64_img: str) -> Image.Image:
        """
        Converts a base64-encoded string to a PIL Image object.

        Args:
            base64_img (str): The base64-encoded string to be converted.

        Returns:
            Image.Image: A PIL Image object representing the decoded image.

        Raises:
            ValueError: If the base64 string is invalid.
            IOError: If the image cannot be processed.
        """
        try:
            # Decode the base64 string
            image_data = base64.b64decode(base64_img)
        except base64.binascii.Error as e:
            raise ValueError("Invalid base64 string.") from e

        try:
            # Load the image from the decoded bytes
            with io.BytesIO(image_data) as image_stream:
                image = Image.open(image_stream)
                image.load()
            return image
        except IOError as e:
            raise IOError(f"Failed to process the image. {e}") from e
