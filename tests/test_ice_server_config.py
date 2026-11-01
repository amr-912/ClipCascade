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
    turn_routes = [x for x in servers if x["urls"][0].startswith(("turn:", "turns:"))]
    assert turn_routes[0]["urls"] == ["turns:turn.cloudflare.com:443?transport=tcp"]
    assert len(turn_routes) >= 2  # TLS443, then UDP/TCP fallbacks
    assert all(x["username"] == "temporary-user" and
               x["credential"] == "temporary-token" for x in turn_routes)
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



def test_aiortc_production_rotates_one_turn_per_peer_and_clears_stale_route():
    source = (os.path.join(os.path.dirname(__file__), "..", "ClipCascade_Desktop",
                           "src", "p2p", "p2p_manager.py"))
    with open(source, encoding="utf-8") as handle:
        code = handle.read()
    assert 'self._turn_route_index.get(remote_peer_id, 0) % len(turn_servers)' in code
    assert 'self._turn_route_index[remote_peer_id] = (' in code
    assert 'self._turn_route_index.pop(old_pid, None)' in code
    assert 'iceServers=stun_servers + selected_turn' in code


def test_worker_route_toml_is_valid_and_scoped_to_one_issuer_prefix():
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    config = tomllib.loads((root / "cloudflare" / "turn-issuer" / "wrangler.toml").read_text(encoding="utf-8"))
    assert config["routes"] == [
        {"pattern": "sync.world-honey.com/ice-servers*", "zone_name": "world-honey.com"}
    ]
