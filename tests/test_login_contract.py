"""SHA3-512 ClipCascade relay login and TURN probe contracts: fully offline."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import hashlib
import json
import urllib.parse

p = Path(__file__).resolve().parents[1] / "tools" / "Probe-ClipCascadeLogin.py"
spec = importlib.util.spec_from_file_location("turn_login_probe", p)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class LoginContract(TestCase):
    def test_sha3_512_is_submitted_instead_of_raw_password(self):
        form = urllib.parse.parse_qs(
            mod.login_form("raqim", "secret-test-string", "csrf-test").decode("utf-8")
        )
        self.assertEqual(form["username"], ["raqim"])
        self.assertEqual(form["_csrf"], ["csrf-test"])
        self.assertEqual(form["password"],
                         [hashlib.sha3_512(b"secret-test-string").hexdigest()])
        self.assertNotIn("secret-test-string", str(form))

    def test_parser_accepts_input_attribute_order(self):
        for html in (
            '<input type="hidden" name="_csrf" value="safe-token">',
            '<input value="safe-token" name="_csrf" type="hidden">',
        ):
            parser = mod.CsrfParser()
            parser.feed(html)
            self.assertEqual(parser.value, "safe-token")

    def test_authorization_must_be_explicit_affirmative(self):
        for accepted in ("OK", '"OK"', '{"valid":true}',
                         '{"authenticated":true,"status":"valid"}'):
            self.assertTrue(mod.strict_session_ok(accepted))
        for rejected in ('Bad credentials', '<html>Login</html>',
                         '{"valid":false}', '{"authenticated":true}',
                         '{"status":"valid"}', '', 'Unauthorized'):
            self.assertFalse(mod.strict_session_ok(rejected))

    def test_existing_protocol_can_issue_turn(self):
        urls = []
        def local_fetch(_opener, path, body=None):
            urls.append(path)
            if path == "/login" and body is None:
                return 200, '<input type="hidden" name="_csrf" value="token">'
            if path == "/login" and body is not None:
                form = urllib.parse.parse_qs(body.decode())
                self.assertEqual(
                    form["password"],
                    [hashlib.sha3_512("password-test".encode()).hexdigest()]
                )
                return 200, ""
            if path == "/validate-session":
                return 200, "OK"
            if path == "/ice-servers":
                return 200, json.dumps({"iceServers": [
                    {"urls": ["stun:cloudflare.com:3478", "turns:example:443"],
                     "username": "temporary-user", "credential": "temporary-key"}
                ]})
            self.fail("unexpected path")

        with patch.object(mod, "fetch", local_fetch):
            self.assertTrue(mod.probe("raqim", "password-test", object()))
        self.assertEqual(urls, ["/login", "/login", "/validate-session", "/ice-servers"])

    def test_post_login_redirect_is_not_followed_and_requires_session_proof(self):
        for redirect_status in (302, 303):
            visited = []
            def local_fetch(_opener, path, body=None):
                visited.append(path)
                if path == "/login" and body is None:
                    return 200, '<input name="_csrf" value="safe-token">'
                if path == "/login" and body is not None:
                    return redirect_status, ""
                if path == "/validate-session":
                    return 200, "OK"
                if path == "/ice-servers":
                    return 200, json.dumps({"iceServers": [{
                        "urls": ["turns:turn.example:443"],
                        "username": "ephemeral-user", "credential": "ephemeral-key"
                    }]})
                self.fail("unsafe external redirect or unexpected request")
            with patch.object(mod, "fetch", local_fetch):
                self.assertTrue(mod.probe("user", "secret-test", object()))
            self.assertEqual(visited,
                             ["/login", "/login", "/validate-session", "/ice-servers"])

    def test_login_redirect_with_rejected_cookie_cannot_mint_turn(self):
        visited = []
        def local_fetch(_opener, path, body=None):
            visited.append(path)
            if path == "/login" and body is None:
                return 200, '<input name="_csrf" value="safe-token">'
            if path == "/login" and body is not None:
                return 302, ""
            if path == "/validate-session":
                return 401, ""
            self.fail("TURN must not be called for a rejected session")
        with patch.object(mod, "fetch", local_fetch):
            self.assertFalse(mod.probe("user", "secret-test", object()))
        self.assertEqual(visited, ["/login", "/login", "/validate-session"])

    def test_401_session_prevents_turn_api_call(self):
        visited = []
        def local_fetch(_opener, path, body=None):
            visited.append(path)
            if path == "/login" and body is None:
                return 200, '<input name="_csrf" value="token">'
            if path == "/login" and body is not None:
                return 200, ""
            if path == "/validate-session":
                return 401, ""
            self.fail("TURN called after invalid auth")

        with patch.object(mod, "fetch", local_fetch):
            self.assertFalse(mod.probe("raqim", "password-test", object()))
        self.assertEqual(visited, ["/login", "/login", "/validate-session"])

    def test_turn_response_requires_credentials(self):
        self.assertEqual(mod.safe_turn_count('{"iceServers":[{"urls":"turn:host:3478"}]}'), 0)
        self.assertEqual(mod.safe_turn_count('{"iceServers":[{"urls":"turns:host:443","username":"u","credential":"c"}]}'), 1)
        self.assertEqual(mod.safe_turn_count('not-json'), 0)
