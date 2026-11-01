#!/usr/bin/env python3
"""One-shot isolated ClipCascade auth/TURN probe (does not alter app DATA).

IMPORTANT: --activate-login deliberately creates a NEW remote login session.
This may replace a live session if the relay implements single-session policy.
Do not activate it while preserving an unknown session is critical.

Never prints passwords, SHA3 hashes, cookies, CSRF, or TURN credentials.
Pure Python 3 stdlib; redirects disabled; fixed trusted HTTPS hostname.
"""
import argparse
from getpass import getpass
from hashlib import sha3_512
from html.parser import HTMLParser
import http.cookiejar
import json
import urllib.error
import urllib.parse
import urllib.request

HOST = "https://sync.world-honey.com"
MAX_BYTES = 131072


class CsrfParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.value = ""

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "input":
            return
        data = dict(attrs)
        if data.get("name") == "_csrf":
            self.value = data.get("value", "")


class NeverRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def login_form(username, password, csrf):
    """Match Android App.js and Windows CipherManager exactly."""
    digest = sha3_512(password.encode("utf-8")).hexdigest()
    return urllib.parse.urlencode({
        "username": username, "password": digest, "_csrf": csrf
    }).encode("utf-8")


def strict_session_ok(body):
    text = body.strip()
    if text in ("OK", '"OK"'):
        return True
    if len(text) > 2048 or not text.startswith("{"):
        return False
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return False
    return isinstance(data, dict) and (
        data.get("valid") is True or (
            data.get("authenticated") is True and data.get("status") == "valid"
        )
    )


def safe_turn_count(body):
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return 0
    if not isinstance(data, dict) or not isinstance(data.get("iceServers"), list):
        return 0
    count = 0
    for ice in data["iceServers"]:
        if not isinstance(ice, dict):
            continue
        urls = ice.get("urls")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list):
            continue
        if (ice.get("username") and ice.get("credential")
                and any(isinstance(url, str) and
                        url.startswith(("turn:", "turns:")) for url in urls)):
            count += 1
    return count


def fetch(opener, path, body=None):
    if path not in ("/login", "/validate-session", "/ice-servers"):
        raise ValueError("Unrecognized local service path")
    req = urllib.request.Request(
        HOST + path, data=body,
        headers={"Accept": "application/json", "Cache-Control": "no-store",
                 **({"Content-Type": "application/x-www-form-urlencoded"} if
                    body is not None else {})},
        method="POST" if body is not None else "GET"
    )
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, response.read(MAX_BYTES).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        # Never reflect server responses, even on credentials failures.
        return error.code, ""
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, ""


def probe(username, password, opener):
    status, html = fetch(opener, "/login")
    print("LOGIN_PAGE_HTTP=" + str(status))
    if status != 200:
        print("RESULT=LOGIN_PAGE_UNAVAILABLE")
        return False
    parser = CsrfParser()
    parser.feed(html)
    if not parser.value:
        print("RESULT=CSRF_NOT_FOUND")
        return False
    post_data = login_form(username, password, parser.value)
    status, login_body = fetch(opener, "/login", post_data)
    print("LOGIN_HTTP=" + str(status))
    if status != 200 or "bad credentials" in login_body.lower():
        print("RESULT=NEW_LOGIN_REJECTED")
        return False

    # Login 200 itself is never sufficient. The existing relay must validate
    # the cookie explicitly, with a strict affirmative response.
    status, body = fetch(opener, "/validate-session")
    print("AUTH_HTTP=" + str(status))
    if status != 200 or not strict_session_ok(body):
        print("RESULT=NEW_SESSION_NOT_AUTHORIZED")
        return False

    print("AUTH_SESSION=ACCEPTED")
    status, body = fetch(opener, "/ice-servers")
    print("TURN_HTTP=" + str(status))
    if status != 200:
        print("RESULT=TURN_ISSUER_REJECTED_OR_UNAVAILABLE")
        return False
    count = safe_turn_count(body)
    print("TURN_CREDENTIAL_SETS=" + str(count))
    print("TURN_READY=" + str(count > 0))
    print("RESULT=" + ("TURN_ISSUED" if count else "TURN_RESPONSE_INVALID"))
    return count > 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--username", default="", help="Existing ClipCascade username")
    ap.add_argument("--activate-login", action="store_true",
                    help="Consent to creating a separate login session")
    args = ap.parse_args()
    if not args.activate_login:
        print("RESULT=LOGIN_NOT_ATTEMPTED")
        print("REASON=NEW_SESSION_MAY_AFFECT_EXISTING_CONNECTION")
        return

    username = args.username or input("ClipCascade username: ").strip()
    if not username:
        print("RESULT=USERNAME_REQUIRED")
        return
    password = getpass("ClipCascade password (hidden, local only): ")
    if not password:
        print("RESULT=PASSWORD_REQUIRED")
        return

    cookiejar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookiejar), NeverRedirect()
    )
    probe(username, password, opener)
    del password, opener, cookiejar


if __name__ == "__main__":
    main()
