# TURN handoff — existing session and VPN acceptance (2026-11-01)

## Verified live state

Stable ClipCascade Windows and Android have kept synchronizing text via
`https://sync.world-honey.com`; this was known before TURN troubleshooting.
Cloudflare route `sync.world-honey.com/ice-servers*` is saved, and GETs with and
without query strings now return unauthenticated HTTP 401 AUTH_REQUIRED.

A separate login attempt returned 401 Bad credentials. This does **not**
prove a one-session limit, nor that the existing client is disconnected.
No end-to-end issuance or relay path has been proven yet.

## No-new-login diagnostic (Windows)

Source: `tools/Diagnose-ClipCascadeTurn.ps1` in this branch. It reads
an existing saved `cookie.JSESSIONID` in `DATA` beside the installed
`ClipCascade.exe`. It does not log in, prompt for a password, modify config,
print cookies or TURN secrets, or send a session to an unexpected hostname.

Open PowerShell and run the downloaded local script:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Diagnose-ClipCascadeTurn.ps1"

If the installed program is not discoverable via its process, specify its
existing `DATA` path with `-DataPath`. Optional `-InspectOnly` validates the
local file and host without any network requests.

- `RESULT=TURN_ISSUED`: existing cookie was accepted and time-limited
  TURN credentials were generated. **Not** proof of a relayed connection.
- `RESULT=EXISTING_SESSION_NOT_RECOGNIZED`: saved cookie may be stale;
  an already-established WebSocket can keep transferring data. Avoid changing
  the relay or password hash.
- `AUTH_HTTP=200` and `SESSION_AUTHORIZED=False`: auth server's positive
  body does not match the explicit affirmative contract; examine existing
  relay source/response before changing Worker authentication.
- `TURN_HTTP=401` after `SESSION_AUTHORIZED=True`: examine forward-cookie
  handling and actual deployed issuer code.
- `TURN_HTTP=503`: examine token/key availability and worker logs.
- `NO_REUSABLE_SESSION` or `DATA_NOT_FOUND`: no valid local persisted
  cookie located; do not infer connection failure.

The Android App uses the native cookie jar and literal `OK` to validate its
current session. Windows persists `JSESSIONID` and sends it to
`/ice-servers`. The old Cloudflare relay implementation was not present
in the connected GitHub repositories, so its live positive auth response
remains a verification gate.

## Hardware preview acceptance gate

1. Preserve stable Windows 3.3.4 and the official Android installation.
   Portable Windows preview and side-by-side Android preview should run
   instead of, not concurrently with, the stable clipboard monitors.
2. Confirm both preview clients can log in to the existing server and receive
   `ICE: TURN available`. This is configuration only.
3. Android Preview now identifies the selected WebRTC ICE route using RTCStats,
   and reports only privacy-safe `TURN relay selected`, `direct selected`,
   or `unverified`; never prints addresses or credentials.
4. Switch VPN on/off on each device; verify new text and image delivery in
   both directions, recipient acknowledgment, screenshot auto-sync for newly
   saved Samsung screenshots, reconnect after VPN/sleep, and repeat across
   TURN 1-hour credential lifetime. `Path: TURN relay selected` is independent
   evidence of actual relay selection, not proof that data reached clipboard.
5. Never share DATA, tokens, cookies, raw RTCStats, SDP, or client secrets.
6. Rollback by disabling **only** the isolated `/ice-servers*` route, never
   the existing `raqim-clipboard-relay` worker or its custom domain.

## CI versus live verification

Automated tests can verify PowerShell diagnostic behavior on safe fixtures,
Android selected-pair classification, Kotlin, Windows client tests, and
packaged preview binaries. They cannot inspect the live Cloudflare account,
validate a real cookie, or demonstrate actual VPN relay or Samsung clipboard
behavior. Do not claim those gates as passed without physical tests.


## 2026-11-01: field diagnosis after safe existing-session probe

Real Windows probe output:
- DATA_PRESENT=True, SESSION_PRESENT=True, SERVER_HOST_VERIFIED=True.
- AUTH_HTTP=401, SESSION_AUTHORIZED=False.
- RESULT=EXISTING_SESSION_NOT_RECOGNIZED.

**Interpretation:** the stored JSESSIONID is rejected by the live old relay's
HTTP session validator, yet the operator confirms the desktop↔Android P2P
clipboard is *actively transferring data*. The two observations can coexist:
an established WebSocket/data channel may remain open after session
expiration, but this possibility does not establish the specific cause.
Do not conclude the user is logged out of the working P2P session, that
passwords changed, or that the server enforces one-session-only logins.

**Previously issued manual login diagnostic had an incorrect wire contract**:
it posted the entered plaintext password, whereas BOTH official clients
pre-hash the entered password with lowercase hexadecimal SHA3-512 before
the HTTP POST to /login. Windows source: CipherManager.string_to_sha3_512_lowercase_hex
called by Application.authenticate_and_connect. Android source:
stringToSHA3_512LowercaseHex in App.js handleLogin. Therefore the former
401 Bad credentials on the manual PowerShell login attempt cannot be treated
as evidence that the operator entered the wrong password.

A separate *opt-in* correct-contract test exists at
`tools/Probe-ClipCascadeLogin.py`. It uses the Python stdlib, SHA3-512,
CSRF, cookiejar, strict validator response and timeouts. It does not edit
the installed DATA or reveal credentials. **By default it does not sign in**:
`RESULT=LOGIN_NOT_ATTEMPTED`. A user would have to add
`--activate-login` explicitly to create a separate server session.
Because the existing relay's single-session policy is unknown and the
operator's existing connection is valuable, do **not** recommend running
this opt-in step until the possibility of invalidating the active
connection has been evaluated or a safe interruption is acceptable.

Cloudflare documentation says fetch from a route Worker to a Worker
on a Custom Domain on the same zone can succeed without a service
binding. This supports the proposed issuer->legacy validator architecture,
but is **not proof that live authentication succeeds**.
https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

**Next gate:** verify an authenticated cookie after explicit consent to a
new session or by a client-owned safe refresh path. Only then can
`/ice-servers` mint temporary TURN credentials. Keep the existing
production relay and official client installations unchanged.
