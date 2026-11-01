"""Pure-logic TURN configuration tests. No live Cloudflare credentials required."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ClipCascade_Desktop", "src"))
from p2p.ice_server_config import fetch_ice_servers, normalize_ice_servers


def mock_payload(now=1000):
    return {"expiresAt": (now + 3600) * 1000,
            "iceServers": [
                {"urls": ["stun:stun.cloudflare.com:3478"]},
                {"urls": [
                    "turn:turn.cloudflare.com:3478?transport=udp",
                    "turn:turn.cloudflare.com:443?transport=udp",
                    "turns:turn.cloudflare.com:443?transport=tcp",
                ], "username": "temporary-user", "credential": "temporary-token"}]}


def test_tls_over_tcp_443_wins_on_aiortc_with_stun_still_available():
    servers, expiry, has_turn = normalize_ice_servers(
        mock_payload(), "stun:stun.example:3478", now=1000)
    assert has_turn
    assert servers[-1]["urls"] == ["turns:turn.cloudflare.com:443?transport=tcp"]
    assert servers[-1]["username"] == "temporary-user"
    assert servers[-1]["credential"] == "temporary-token"
    assert any(s["urls"] == ["stun:stun.example:3478"] for s in servers)
    assert 1000 < expiry <= 1000 + 2700


def test_rejects_unauthed_relay():
    try:
        normalize_ice_servers({"iceServers": [
            {"urls": ["turn:turn.cloudflare.com:3478?transport=udp"]}]}, "",
            now=1000)
    except ValueError:
        pass
    else:
        raise AssertionError("TURN credentials must be mandatory")


def test_fetch_uses_logged_in_session_and_short_timeout():
    seen = {}

    class Response:
        status_code = 200

        def json(self):
            return mock_payload()

    def request(url, **kw):
        seen.update(url=url, **kw)
        return Response()

    ice, expiry, relay = fetch_ice_servers(
        "https://sync.example", "stun:stun.example:3478",
        {"JSESSIONID": "temporary-session"}, request_get=request, now=1000)
    assert relay and expiry > 1000
    assert seen["url"] == "https://sync.example/ice-servers"
    assert seen["headers"]["Cookie"] == "JSESSIONID=temporary-session;"
    assert seen["timeout"] == 4


def test_unavailable_issuer_keeps_previous_stun_behavior():
    class Response:
        status_code = 503

    ice, _, relay = fetch_ice_servers(
        "https://sync.example", "stun:stun.example:3478",
        {"JSESSIONID": "temporary-session"},
        request_get=lambda *_a, **_kw: Response(), now=1000)
    assert not relay
    assert ice == [{"urls": ["stun:stun.example:3478"]}]


def test_refuse_plain_http_remote_turn_credentials():
    def forbidden(*a, **kw):
        raise AssertionError("should not fetch plaintext auth")

    ice, _, relay = fetch_ice_servers(
        "http://evil.example", "stun:stun.example:3478", {},
        request_get=forbidden, now=1000)
    assert not relay
    assert len(ice) == 1
