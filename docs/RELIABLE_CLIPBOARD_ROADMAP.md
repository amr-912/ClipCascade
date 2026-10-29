# ClipCascade reliability plan: image clipboard, VPN and delivery

**Status:** engineering design, not deployed. The screenshot detection change is a separate draft PR.

## Desired outcomes

- Windows clipboard screenshots, text, and in-memory images are copied to Android's active clipboard without changing Windows screenshot shortcuts.
- Explorer file copies preserve their file/attachment meaning. Binary PDF/DOCX content is not promised as universally pasteable through Android clipboard.
- The existing Android FileProvider-based image clipboard integration remains the first receiver implementation; test Samsung Keyboard history separately from actual pasteability.
- VPN changes, Wi-Fi changes, mobile-data changes, and transient server failures trigger automatic bounded reconnection; events acknowledged by the receiver are never knowingly discarded.

## Confirmed upstream constraints

See `ClipCascade_Server/API.md`:

- Server-level mode: P2P signaling (`/p2psignaling`, WebRTC, one STUN URL), or P2S STOMP relay (`/clipsocket`).
- No TURN relay, automatic P2S fallback, durable queue, receiver acknowledgement, or offline replay across reconnect.
- Android P2P code currently fragments messages into 15,360-byte parts; receiving fragment buffers have a 60-second idle TTL.
- Android stores incoming images in app cache as PNG and places a `content://` URI on the system clipboard; Samsung Keyboard history support is not guaranteed.

## Proposed architecture, subject to measurement

### 1. Shared delivery model

Create one event envelope for both transports:

- `eventId` (random), `senderDeviceId`, `revision`, `kind`, content MIME, byte limits, TTL, and ciphertext integrity commitment.
- Encrypt the actual clipboard payload before relay. Authenticate routing/metadata as appropriate to protect against tampering.
- Per-recipient bounded outbox with ack on successful clipboard application, idempotent replay and bounded retry; never log payloads.
- Chunk acknowledgements and resumable transfers, with strict total size and memory limits; temporary content must be purged after expiry.

### 2. Transport policy

- Authenticated WSS/TLS/443 relay/control channel stays available while the user has sync enabled.
- Opportunistic P2P for large content when healthy; avoid opening two payload transfers for the same event.
- Detect connectivity change rather than trusting only the VPN indicator; reconnect WebSocket, renegotiate/recreate ICE, and fall back to WSS.
- Apply exponential backoff with jitter. Stop/Logout disables reconnection and clears pending sensitive state under a defined policy.
- TURN is optional and justified by measured P2P improvements, not mandatory.

### 3. Server and deployment

- Preserve the current production sync endpoint until a staging environment reproduces the new protocol.
- Java backend behind Cloudflare remains the simplest option if it is already deployed. A Worker/Durable Object relay is a separate implementation and cannot run the Java Spring binary unchanged.
- Isolate project credentials, secrets, routes, and workflow from RAQIM and World Honey application deployments.
- Use versioned backend + compatibility negotiation + rollback. Ship Android and Windows clients after verified server compatibility.

### 4. Platform-specific safety

- Windows: `WM_CLIPBOARDUPDATE` event-driven monitoring; inspect actual clipboard data formats, do not install screenshot hooks, retry locked clipboard without blocking GUI thread.
- Android: preserve `READ_LOGS` background clipboard workaround; test image URI lifetime and paste access in target applications; measure battery.
- Android app's existing signing certificate cannot be duplicated from public repository. Fork builds signed with a different key cannot replace the existing installed app under the same package name.
- For staging, use a separate Android application ID and test keystore; do not uninstall the working app.

## Acceptance before production

1. Real Windows 11 screenshot: `Win+Shift+S`, `PrtSc`, screen snip and copied webpage image; each automatically pastes on Android.
2. Explorer image/PDF copy: preserves file semantics; no silent upload of unrelated files.
3. Bidirectional Unicode text and large code snippets work without duplicate echoes.
4. VPN on/off on phone and PC, Wi-Fi to mobile data, sleep/wake; reconnection is bounded and observable.
5. Interrupted multi-MB transfers: resumed or explicit failure, no silent truncation; no duplicate delivery.
6. No payload plaintext in logs. E2EE maintained; test server and client version skew and rollback.
7. GitHub Actions validation, true Windows desktop smoke test, Samsung One UI instrumentation/manual verification, and before/after battery and bandwidth checks.

## Release gates

1. Draft PR, CI and unit tests.
2. Windows clipboard smoke test on a test install.
3. Separate staging server and compatible clients; sign client builds securely.
4. Canary release, measured tests, rollback ready.
5. Enable production deployment only after explicit acceptance.
