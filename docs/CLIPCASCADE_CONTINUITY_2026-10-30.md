# ClipCascade — Engineering continuity / field evidence (2026-10-30)

**Repository:** `amr-912/ClipCascade` (user-owned GitHub fork; original upstream `Sathvik-Rao/ClipCascade`).

**Safe deployment boundaries**

- Windows stable installer **3.3.4** is already installed on the Dell Precision 5560 (Windows 11). Keep it untouched. Windows 3.3.5 Preview was never installed on that PC.
- Android original **3.3.0** is still installed as `com.clipcascade`. Keep it untouched.
- Experimental Android is debug-signed and side by side as `com.clipcascade.preview`; stop original's foreground service when testing Preview.
- Existing server `https://sync.world-honey.com` uses P2P signaling `wss://sync.world-honey.com/p2psignaling`. Production backend is **not altered** by this PR.
- The Windows image fix is tracked as **Draft PR #1** (`fix/windows-clipboard-image-events`); Android/network follow-up is **Draft PR #2** (`fix/bidirectional-clipboard-delivery`), with base PR #1 branch. **Do not merge both without release gates.**
- Never upload account passwords, encryption hashes, cookies, raw `DATA` configuration, clipboard text, screenshot bytes, or private URI strings into reports or Git.

## Observed physical-device evidence (confirmed by user)

1. Windows `Win+Shift+S` screenshot automatically appears in Samsung's clipboard with stable Windows 3.3.4.
2. Android Preview text copy reaches Windows; `Peers: 1` and connected were shown on Samsung S24.
3. Samsung hardware screenshot did **not** reach Windows automatically with the first Preview.
4. Android diagnostic after screenshot (before MediaStore feature): `detectedType: text`, `mimeTypes: [text/plain]`, `hasUri: false`, `imageReadable: not-tested`. In repeated snapshots the event count increased but the primary clipboard stayed text. This is not proof that Samsung's private keyboard history is readable.
5. A different diagnostic showed `imageReadable: yes` with `lastEventType: remote-image`, i.e. an image previously received from Windows, deliberately anti-echo tagged.
6. **Critical field result:** Samsung Gallery → Share → ClipCascade Preview → Windows Paint Ctrl+V **successfully delivered the image**. Thus the Android image serialization, encrypted P2P sending and Windows image reception work when a readable image URI is supplied. Avoid rebuilding them without new evidence.
7. ADB `READ_LOGS` and `SYSTEM_ALERT_WINDOW` grants to `com.clipcascade.preview` were verified in Windows PowerShell, and USB was authorized as `device`.

## What the new opt-in Android feature changes

- New `ScreenshotMediaMonitor.kt`: Android's official `MediaStore.Images` with `ContentObserver` watches **only new saved screenshots** after a baseline of existing images. Only screenshots by folder or conventional name, non-zero image size, not-pending rows, deduplicated IDs are eligible. Never send existing library photos.
- Native `ClipboardListenerModule.kt`: permission check and start/stop on active foreground service, existing `onClipboardChange` image pathway, diagnostic counters `screenshotMonitorActive` and `savedScreenshotEvents`.
- `App.js`: connected-page **Enable Auto-Sync Screenshots** opt-in; request full photos permission; toggle persists via `auto_sync_screenshots`. If off, no background media observer.
- `StartForegroundService.js`: activates the monitor only when user opted in and the service is running. Stop disconnects observer. Reuses image Base64/E2EE/P2P/Windows CF_DIB pipeline.
- Debug source is reproducible using the checked-in CI build and the PR branch; no APK is kept as the only copy of an algorithm.

**Privacy/technical limits:** MediaStore is *not* Samsung Keyboard's proprietary clipboard. Copies of unsaved images may still need Share. Permissions can be denied/revoked. Full photo access is a sensitive permission; only use after explicit opt-in. Device's screenshot naming and MediaStore row notifications require real Samsung verification. OS restrictions/background process termination can affect liveness.

## VPN / transport truth

- Previous version used only STUN; its signaling WebSocket can stay connected while the **WebRTC DataChannel is not open**. `Peers: 1` only confirms an active data channel at that instant, not delivery of every clip.
- Android now observes both `pc.connectionState` and `pc.iceConnectionState` for VPN/network transitions; Windows' aiortc side also has bounded transient disconnect grace and recovery. Pending latest clipboard copy in memory is replayed on data channel open (without a receipt ACK). Do not claim this is a VPN proof or full delivery guarantee.
- **STUN-only cannot traverse every restricted NAT/VPN.** A genuinely robust solution needs private authenticated TURN (ideally UDP plus TLS/TCP 443) enabled on **both** Android and Windows, or a separate capability-negotiated authenticated WSS encrypted-content relay with per-message ACK, bounded queues, expiry, backpressure and deduplication.
- The existing P2P signaling endpoint is **not** a clipboard payload relay. No production server/TURN changes are made by this branch. A VPN relay implementation needs server access, infrastructure configuration, matching client capabilities and real network field tests. Never silently downgrade encryption.

## Release and disaster-recovery protocol

1. Restore source via `git clone https://github.com/amr-912/ClipCascade.git`; checkout `fix/bidirectional-clipboard-delivery`. PR #2 includes PR #1 history because its base is the Windows image branch. Git remote preserves all commits and test scripts.
2. Trigger/check `.github/workflows/bidirectional_clipboard_tests.yml` on the branch; it should compile Kotlin, run Robolectric screenshot/clipboard suites, run JS behavior tests, execute Windows Python tests on Linux/Windows, assemble and upload a debug-signed **Android Preview** APK. CI artifacts are short-lived; source is the durable backup.
3. On Samsung stop original service but don't uninstall; install Preview side by side, sign in with matching encryption, allow full photo access **only if choosing to auto-sync screenshots**, enable toggle, start service, take a NEW screenshot, inspect `savedScreenshotEvents`, paste to Windows Paint. Verify Android text and Windows image direction again.
4. For VPN test: compare both devices with VPN off/on, Wi-Fi/mobile switching, USB vs no USB, screenshot latency, P2P DC reconnection, and clipboard echo. If no live P2P route, do not label reconnect attempts as success.
5. Rollback: stop Preview on phone and start original Android 3.3.0 service. Windows 3.3.4 and production server remain untouched. No client auto-upgrade or destructive migration in this PR.
6. **Never declare full field acceptance without a newly assembled APK installed and tested on the Samsung S24.** The user's old Preview does not yet include the MediaStore feature.

## Important future work

- Hardware verification of actual MediaStore screenshot observation, especially Samsung-specific screenshot paths and Android 16's full/partial image permission semantics.
- End-to-end sender/receiver delivery acknowledgements and bounded retry/dedup for intermittent copy reliability; none proven on the phone.
- TURN/server relay for strict VPN networks (not implemented).
- Release signing/versioning, automated rollback and merge strategy for PR #1/#2 after acceptance.
