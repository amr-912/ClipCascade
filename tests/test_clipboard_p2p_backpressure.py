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
import typing
import uuid

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "ClipCascade_Desktop/src/p2p/p2p_manager.py"


def get_sender():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "P2PManager")
    names = {"_send", "_send_chunk_with_backpressure", "_remember_pending_clipboard", "_flush_pending_clipboard", "_clear_peer_ack", "_clear_all_acks", "_watch_ack"}
    methods = [n for n in original.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert {n.name for n in methods} == names
    methods.append(ast.parse("@staticmethod\ndef fragment_string(payload):\n    return [payload]").body[0])
    methods.append(ast.parse("def __init__(self):\n    self._ack_capable_peers=set()\n    self._pending_acks={}\n    self._ack_timeout_sec=20\n    self._ack_max_retries=2").body[0])
    isolated = ast.Module(body=[ast.ClassDef(name="P2PManager", bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(isolated)
    env = {"json": json, "time": time, "asyncio": asyncio, "uuid": uuid, "logging": logging, "Optional": typing.Optional}
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
    mgr.clipboard_manager = types.SimpleNamespace(has_clipboard_changed=lambda x: called.append(x), previous_clipboard_hash=0)
    mgr._pending_outbound_clipboard = None
    mgr._pending_outbound_ttl_sec = 90
    asyncio.run(mgr._send("clipboard-image-as-base64", "image"))
    assert called == []
    assert mgr._pending_outbound_clipboard[0] == "clipboard-image-as-base64"


def test_sending_image_queues_complete_payload_to_open_channel():
    mgr = get_sender()()
    channel = Channel()
    mgr.data_channels = {"peer-1": channel}
    mgr.config = types.SimpleNamespace(data={"cipher_enabled": False})
    mgr.clipboard_manager = types.SimpleNamespace(has_clipboard_changed=lambda p: True, previous_clipboard_hash=0)
    mgr._pending_outbound_clipboard = None
    mgr._pending_outbound_ttl_sec = 90
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


def test_pending_text_is_replayed_when_channel_opens():
    mgr = get_sender()()
    mgr.data_channels = {}
    mgr._pending_outbound_clipboard = None
    mgr._pending_outbound_ttl_sec = 90
    mgr.config = types.SimpleNamespace(data={"cipher_enabled": False})
    mgr.clipboard_manager = types.SimpleNamespace(
        has_clipboard_changed=lambda p: True,
        previous_clipboard_hash=0,
    )
    mgr.reset_sending_fragment_id = lambda: setattr(mgr, "sending_fragment_id", "")
    mgr.sending_fragment_id = ""
    mgr.sending_fragment_stats = None

    async def scenario():
        await mgr._send("hello offline", "text")
        assert mgr._pending_outbound_clipboard[0] == "hello offline"
        ch = Channel()
        mgr.data_channels["phone"] = ch
        await mgr._flush_pending_clipboard()
        return ch

    channel = asyncio.run(scenario())
    assert len(channel.sent) == 1
    assert json.loads(channel.sent[0])["payload"] == "hello offline"
    assert mgr._pending_outbound_clipboard is None


def test_expired_pending_text_is_not_replayed():
    mgr = get_sender()()
    mgr._pending_outbound_clipboard = ("sensitive old clipboard", "text", time.monotonic()-120)
    mgr._pending_outbound_ttl_sec = 90
    mgr.data_channels = {"peer": Channel()}
    asyncio.run(mgr._flush_pending_clipboard())
    assert mgr._pending_outbound_clipboard is None
    assert mgr.data_channels["peer"].sent == []


def test_pending_queue_is_bounded_and_latest_copy_wins():
    mgr = get_sender()()
    mgr._pending_outbound_clipboard = None
    mgr._remember_pending_clipboard("old", "text")
    mgr._remember_pending_clipboard("new", "text")
    assert mgr._pending_outbound_clipboard[:2] == ("new", "text")
    mgr._remember_pending_clipboard("a" * (24*1024*1024+1), "text")
    assert mgr._pending_outbound_clipboard[0] == "new"

def test_vpn_disconnection_recovery_grace_is_bounded_and_cancelled_on_teardown():
    """Static guard for the aiortc event path; physical VPN relay is not simulated."""
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] /
              "ClipCascade_Desktop/src/p2p/p2p_manager.py").read_text(encoding="utf-8")
    assert '@pc.on("iceconnectionstatechange")' in source
    assert 'pc.iceConnectionState' in source
    assert "self.loop.call_later(15.0, recover_if_still_disconnected)" in source
    assert "self._peer_disconnect_grace_handles.clear()" in source
    assert "self._peer_disconnect_grace_handles.pop(peer_id, None)" in source
    assert "self._recover_peer_transport(remote_peer_id, pc)" in source
