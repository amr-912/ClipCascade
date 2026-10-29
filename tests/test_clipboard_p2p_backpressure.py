"""Regression tests for bounded WebRTC clipboard sends.

Extract production async methods via AST to avoid importing aiortc and Win32
on platforms where they are unavailable; implementation is not re-created.
"""
import ast
import asyncio
import json
import logging
import pathlib
import time
import types
import uuid

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "ClipCascade_Desktop/src/p2p/p2p_manager.py"


def get_sender():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "P2PManager")
    names = {"_send", "_send_chunk_with_backpressure"}
    methods = [n for n in original.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert {n.name for n in methods} == names
    methods.append(ast.FunctionDef(name="fragment_string", args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="payload")], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]), body=[ast.Return(value=ast.List(elts=[ast.Name(id="payload", ctx=ast.Load())],ctx=ast.Load()))], decorator_list=[ast.Name(id="staticmethod", ctx=ast.Load())]))
    isolated = ast.Module(body=[ast.ClassDef(name="P2PManager", bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(isolated)
    env = {"json": json, "time": time, "asyncio": asyncio, "uuid": uuid, "logging": logging}
    exec(compile(isolated, str(SOURCE), "exec"), env)
    return env["P2PManager"]


class Channel:
    readyState = "open"
    def __init__(self):
        self.bufferedAmount = 0
        self.sent = []
    def send(self, data):
        self.sent.append(data)
        self.bufferedAmount += len(data.encode("utf-8"))


def test_sending_does_not_record_hash_if_no_open_peer():
    mgr = get_sender()()
    called = []
    mgr.data_channels = {}
    mgr.clipboard_manager = types.SimpleNamespace(has_clipboard_changed=lambda x: called.append(x))
    asyncio.run(mgr._send("clipboard-image-as-base64", "image"))
    assert called == []


def test_sending_image_queues_complete_payload_to_open_channel():
    mgr = get_sender()()
    channel = Channel()
    mgr.data_channels = {"peer-1": channel}
    mgr.config = types.SimpleNamespace(data={"cipher_enabled": False})
    mgr.clipboard_manager = types.SimpleNamespace(has_clipboard_changed=lambda p: True)
    mgr.reset_sending_fragment_id = lambda: setattr(mgr, "sending_fragment_id", "")
    mgr.reset_receiving_fragments = lambda: None
    mgr.sending_fragment_id = ""
    mgr.sending_fragment_stats = None
    asyncio.run(mgr._send("image-base64", "image"))
    assert len(channel.sent) == 1
    body = json.loads(channel.sent[0])
    assert body["type"] == "image"
    assert body["payload"] == "image-base64"
    assert mgr.sending_fragment_id == ""


def test_backpressure_pauses_until_buffer_drains():
    sender = get_sender()
    channel = Channel()
    channel.bufferedAmount = 300000

    async def scenario():
        async def drain():
            await asyncio.sleep(0.04)
            channel.bufferedAmount = 0
        future = asyncio.create_task(drain())
        ok = await sender._send_chunk_with_backpressure(
            channel, "test", time.monotonic() + 1, lambda: False
        )
        await future
        return ok
    assert asyncio.run(scenario())
    assert channel.sent == ["test"]


def test_backpressure_aborts_if_channel_closed():
    sender = get_sender()
    channel = Channel()
    channel.readyState = "closed"
    assert not asyncio.run(sender._send_chunk_with_backpressure(
        channel, "test", time.monotonic() + 1, lambda: False
    ))
    assert channel.sent == []
