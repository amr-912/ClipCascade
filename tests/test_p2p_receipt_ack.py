"""Actual P2P receipt handler extracted from production AST. No Win32 dependencies."""
import ast
import json
import logging
import pathlib
import types

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "ClipCascade_Desktop/src/p2p/p2p_manager.py"


def make_receiver():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "P2PManager")
    method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_receive")
    module = ast.Module(
        body=[ast.ClassDef(name="OnlyReceiver", bases=[], keywords=[],
                           body=[method], decorator_list=[])],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    scope = {"json": json, "logging": logging}
    exec(compile(module, str(SOURCE), "exec"), scope)
    mgr = scope["OnlyReceiver"]()
    mgr.config = types.SimpleNamespace(
        data={"max_clipboard_size_local_limit_bytes": None, "cipher_enabled": False}
    )
    mgr._pending_acks = {}
    mgr._ack_capable_peers = set()
    mgr.reset_receiving_fragments = lambda: None
    state = {"hash": "", "accepted": True, "writes": []}

    def has_changed(payload):
        if state["hash"] == payload:
            return False
        state["hash"] = payload
        return True

    def paste(base64_string, type_):
        state["writes"].append((base64_string, type_))
        return state["accepted"]

    class Clipboard:
        @property
        def previous_clipboard_hash(self):
            return state["hash"]

        @previous_clipboard_hash.setter
        def previous_clipboard_hash(self, value):
            state["hash"] = value

        has_clipboard_changed = staticmethod(has_changed)
        base64_to_clipboard = staticmethod(paste)

    mgr.clipboard_manager = Clipboard()

    class Channel:
        readyState = "open"
        sent = []

        def send(self, payload):
            self.sent.append(json.loads(payload))

    return mgr, state, Channel()


def frame(message_id="msg-1", payload="photo-bytes"):
    return json.dumps({
        "payload": payload, "type": "image",
        "metadata": {"id": message_id, "isFragmented": False,
                     "combinedRawPayloadSizeInBytes": len(payload)},
    })


def test_receipt_ack_only_when_peer_negotiated_and_copy_was_applied():
    mgr, state, channel = make_receiver()
    mgr._receive(frame(), "phone", channel)
    assert state["writes"] == [("photo-bytes", "image")]
    assert channel.sent == []  # Legacy peers work without ACK extension.
    mgr._receive(json.dumps({"_cc_keepalive": True, "ackProtocol": 1}), "phone", channel)
    mgr._receive(frame("msg-2", "newer-image"), "phone", channel)
    assert channel.sent == [{"_cc_ack": "msg-2"}]


def test_failed_image_copy_is_retryable_and_never_acknowledged():
    mgr, state, channel = make_receiver()
    mgr._ack_capable_peers.add("phone")
    state["accepted"] = False
    mgr._receive(frame(), "phone", channel)
    assert state["hash"] == ""
    assert channel.sent == []
    state["accepted"] = True
    mgr._receive(frame(), "phone", channel)
    assert channel.sent == [{"_cc_ack": "msg-1"}]


def test_replayed_identical_copy_is_acknowledged_without_second_paste():
    mgr, state, channel = make_receiver()
    mgr._ack_capable_peers.add("phone")
    mgr._receive(frame("a"), "phone", channel)
    mgr._receive(frame("b"), "phone", channel)
    assert len(state["writes"]) == 1
    assert channel.sent == [{"_cc_ack": "a"}, {"_cc_ack": "b"}]


def test_stale_ack_cannot_clear_a_new_outbound_transfer():
    mgr, _, channel = make_receiver()
    event = []

    class Timer:
        def cancel(self):
            event.append("cancel")

    mgr._pending_acks["phone"] = {"id": "latest", "timer": Timer(), "type": "image"}
    mgr._clear_peer_ack = lambda peer: (event.append(peer), mgr._pending_acks.pop(peer, None))
    mgr._receive(json.dumps({"_cc_ack": "older"}), "phone", channel)
    assert "phone" in mgr._pending_acks
    mgr._receive(json.dumps({"_cc_ack": "latest"}), "phone", channel)
    assert event == ["phone"]
