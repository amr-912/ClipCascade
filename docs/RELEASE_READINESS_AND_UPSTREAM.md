# ClipCascade — release and upstream acceptance gates (2026-10-30)

**This is not a release certificate.** A screenshot auto-sync prototype is present in Git, but **no successful CI run for the new MediaStore code and no physical Samsung S24 field acceptance are evidenced yet**.

## Device-confirmed facts (do not overwrite these)

- Installed Windows 3.3.4: Windows screenshot -> Samsung clipboard worked automatically. Keep it installed.
- Android official 3.3.0: retain installed, stop only its foreground service during Preview testing.
- Android Preview 2026-10-29: text transfers; Samsung Gallery -> Share -> Preview -> Windows Paint image paste worked.
- Android screenshot -> Windows automatic failed. After a phone screenshot, primaryClip was still text/plain; do not claim access to Samsung Keyboard's private history.
- Only the **new** Preview from `test/screenshot-preview-release-2026-10-30` contains MediaStore screenshot monitoring and the JS sender-initialization ordering fix.

## Shipment gate — do not skip

1. In GitHub Actions, run `ClipCascade Android Preview - on-demand safe build` on the **main** workflow (which checks out the selected experiment code); input `source_branch=test/screenshot-preview-release-2026-10-30`.
2. Require **all jobs** to succeed: JS transfer regressions, Windows P2P regressions on Ubuntu and Windows, real Android Kotlin compile, Robolectric clipboard/screenshot selection and Android Preview packaging.
3. Inspect artifact `ClipCascade-Android-Screenshot-AutoSync-Preview`; check `BUILD_INFO.txt` **source_commit** against intended branch head and verify APK SHA256 against `SHA256SUMS.txt`. A different SHA is the wrong build. Never relabel the old 29 Oct Preview as a new APK.
4. Backup/rollback: leave Windows 3.3.4 and Android official 3.3.0 unchanged; Preview is separately signed under `com.clipcascade.preview`. No automatic update or production server modification.
5. On Galaxy S24, confirm connected P2P DataChannel; stop original background service; opt in to `Enable Auto-Sync Screenshots` and grant **all photos** rather than selected-only access. Capture a NEW screenshot, do not Share, and confirm Windows Paint Ctrl+V displays it. Inspect `screenshotMonitorActive`, `savedScreenshotEvents` and `lastTransportStage` if needed.
6. Regression: Android text->Windows, Windows screenshot->Samsung, stop/start of foreground service, revoke photo access, screenshots taken while offline then reconnected, ordinary gallery photos MUST NOT automatically transfer, and no clipboard echo.
7. A GitHub CI pass proves compilation/virtual tests, NOT Samsung background-liveness or actual delivery. Field acceptance is mandatory before calling this a stable release.

## Privacy / access contract

- A user-initiated opt-in controls screenshot monitoring; request `READ_MEDIA_IMAGES` solely for that feature, not normal text sync.
- Android 14+ selected-photo access is insufficient for monitoring *future* new screenshots; explicitly handle/communicate the full-vs-partial permission distinction.
- Observe newly indexed saved screenshots only after a startup baseline. Never backfill photo-library history; filter screenshots by folder/name. No automatic upload of arbitrary gallery photos.
- Only send to connected, authenticated clipboard peers via the existing E2EE channel; never log screenshot bytes, private URIs, clipboard text, credentials, TURN tokens or complete local configuration files.
- `savedScreenshotEvents` means an outbound event was *emitted locally*, not delivered remotely. P2P `queued` also does NOT mean application-level ACK.

## VPN: engineering truth and secure path to an actual solution

Current architecture: WebSocket on `sync.world-honey.com` is for P2P **signaling**, not clipboard payload relay. Both clients presently use STUN only for ICE candidates, with bounded recovery after disconnect. Some VPN/NAT networks cannot establish direct routes; recovery cannot conjure a relay.

A viable managed option **without owning a physical server** is **Cloudflare Realtime TURN**, documented at
https://developers.cloudflare.com/realtime/turn/
with ephemeral credentials described at
https://developers.cloudflare.com/realtime/turn/generate-credentials/.

**Do not hardcode a TURN key in either public Android or Windows binary.** A server-side authenticated issuer (for example a Cloudflare Worker with bound secret, plus rate limits/authorization) generates short-lived credentials; both clients receive ICE server lists, refresh well before expiry, and negotiate ICE with TURN/UDP plus TURN/TCP/TLS 443 alternatives. Keep E2EE end to end and validate the relay credential lifecycle. This requires a provisioned Cloudflare Realtime TURN key, deployment permissions and a new endpoint: **not implemented in this branch**. Without account provisioning or compatible server changes, do not claim VPN universally fixed.

Before upstream contribution of network resiliency: test across normal Wi-Fi, mobile hotspot, one-sided VPN, two-sided VPN and firewall that blocks UDP, with a forced relay requirement; verify auth, turn credential refresh/revoke, no plaintext relay logging, reconnect, delivery ACK and retry/backpressure. STUN-only plus reconnect is not a VPN final solution.

## Upstream contribution plan — separate concerns; each independently reviewable

1. Windows clipboard image event/listener correction in PR #1.
2. Bidirectional P2P transport reliability, anti-echo and bounded queue fixes in an isolated PR with platform regression tests.
3. Android screenshot opt-in via MediaStore in an isolated PR with privacy contract, Android permission compatibility and physical Samsung evidence.
4. TURN credential issuance and ICE failover in its own end-to-end feature PR **only when** backend/token lifecycle and multi-network tests are complete. Avoid coupling upstream with `world-honey.com` or any private environment.

Git source and docs live in `amr-912/ClipCascade`; workflow artifacts are transient and **must not** be the only backup. No sensitive device data, private keys or generated secrets belong in Git.
