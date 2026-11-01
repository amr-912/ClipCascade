"""Authenticated, ephemeral TURN discovery for Windows/Linux aiortc.

The Cloudflare master key must exist only in the ClipCascade server. Do not
persist client TURN usernames or passwords in local settings or log files.
aiortc/aioice currently chooses the first TURN URL, so prefer TLS/TCP 443 on
restricted VPN/firewall networks while leaving direct ICE candidates active.
"""
import re
import time
from urllib.parse import urlsplit

import requests


_URI_RE = re.compile(r"^(stun|stuns|turn|turns):[^\s]{1,295}$", re.I)


def _safe_fallback(stun):
    return [{"urls": [stun]}] if isinstance(stun, str) and _URI_RE.fullmatch(stun) and stun.startswith("stun:") else []


def normalize_ice_servers(payload, fallback_stun, now=None):
    """Return (serializable server dicts, expiry seconds, has_turn). Fail closed."""
    if not isinstance(payload, dict) or not isinstance(payload.get("iceServers"), list):
        raise ValueError("ICE response missing servers")
    now = time.time() if now is None else now
    servers = _safe_fallback(fallback_stun)
    candidates = []
    for item in payload["iceServers"][:12]:
        if not isinstance(item, dict):
            continue
        raw = item.get("urls", [])
        urls = raw if isinstance(raw, list) else [raw]
        for u in urls[:10]:
            if not isinstance(u, str) or not _URI_RE.fullmatch(u):
                continue
            if u.startswith("stun:") and not any(u in x["urls"] for x in servers):
                servers.append({"urls": [u]})
            if u.startswith(("turn:", "turns:")):
                username, secret = item.get("username"), item.get("credential")
                if not all(isinstance(v, str) and 0 < len(v) <= 512 for v in (username, secret)):
                    continue
                candidates.append((u, username, secret))
    # aiortc uses ONE TURN server. Prefer TLS/TCP port 443 for UDP-blocking VPNs.
    order = lambda c: (0 if c[0].startswith("turns:") and ":443?" in c[0] else
                       1 if c[0].startswith("turns:") else
                       2 if "transport=udp" in c[0] else 3)
    if not candidates:
        raise ValueError("No authenticated TURN candidate")
    selected = min(candidates, key=order)
    servers.append({"urls": [selected[0]], "username": selected[1], "credential": selected[2]})
    expiry_ms = payload.get("expiresAt", 0)
    try:
        expiry = float(expiry_ms) / 1000
    except (TypeError, ValueError):
        expiry = now + 1800
    # Re-query before credential expiry; cap cached duration to 45 minutes.
    expiry = min(now + 2700, max(now + 20, expiry - 300))
    return servers, expiry, True


def fetch_ice_servers(server_url, fallback_stun, cookie, verify=True, request_get=None, now=None):
    """Return (iceServers, expirySec, hasTurn); no exceptions or secrets logged."""
    now = time.time() if now is None else now
    fallback = (_safe_fallback(fallback_stun), now + 20, False)
    if not isinstance(server_url, str):
        return fallback
    parts = urlsplit(server_url)
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")):
        return fallback
    if not parts.hostname or parts.username or parts.password:
        return fallback
    try:
        get = request_get or requests.get
        response = get(server_url.rstrip("/") + "/ice-servers",
                       headers={"Accept": "application/json",
                                "Cookie": "JSESSIONID=" + (cookie or {}).get("JSESSIONID", "") + ";"},
                       verify=verify, timeout=4)
        if response.status_code != 200:
            return fallback
        return normalize_ice_servers(response.json(), fallback_stun, now)
    except (ValueError, requests.RequestException, TypeError, AttributeError):
        return fallback
