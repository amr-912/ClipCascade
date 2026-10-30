# Galaxy S24 screenshot → Windows: safe field validation (draft)

This is an **experimental test plan**, not evidence that Android screenshot sharing works on One UI. Do not merge to `main` or deploy a new server based on CI alone.

## Baseline and isolation

- Preserve the installed **Windows 3.3.4** (verified: Win+Shift+S → Samsung clipboard).
- Preserve the official Android **com.clipcascade / 3.3.0** and its data.
- Install the GitHub Actions **ClipCascade-Android-Bidirectional-Preview** APK as **com.clipcascade.preview**, not on top of the official app. Preview is debug-signed. Stop the official app's foreground service with **Stop** while testing. Never run both clipboard monitors simultaneously.
- Sign in to the existing server with matching encryption settings. This is a separate app profile; original app credentials cannot be copied by the preview.
- On Android 10+, if background monitoring is desired, connect authorized ADB USB and use:

```powershell
adb devices
adb -d shell pm grant com.clipcascade.preview android.permission.READ_LOGS
adb -d shell appops set com.clipcascade.preview SYSTEM_ALERT_WINDOW allow
adb -d shell am force-stop com.clipcascade.preview
```

Reopen Preview, accept OS prompts, and press Start. The app also displays package-aware ADB commands. Only run the above if you intend to authorize clipboard monitoring and understand the sensitivity of `READ_LOGS`.

## Screenshot test

1. Confirm Preview connected, DataChannel has at least one live peer, and **Enable Image Sharing** is on. A connected signaling socket alone is insufficient.
2. Press the **Inspect Clipboard (metadata only)** button once to record a baseline of `observedEvents` and `transportEvents`. This button never shows or uploads clipboard content.
3. With Samsung Keyboard's screenshot-to-clipboard option on, capture a NEW screenshot using the phone's physical keys.
4. Without copying another item, return to Preview and press **Inspect Clipboard** again.
5. Read `observedEvents`, `lastEventSource` (`listener` or `overlay`), `lastEventType`, `mimeTypes`, `primaryClipAccessible`, `hasUri`, `detectedType`, `imageReadable`, `transportEvents`, and `lastTransportStage`.
6. On Windows, open **Paint** and press **Ctrl+V**. This is the functional acceptance test; `p2p-image-queued` only proves that the sender queued fragments.
7. Try a normal text copy on Samsung → Windows, then **Win+Shift+S** on Windows → Samsung, to check no regression. Test large images and VPN only after the basic test.

## Interpreting the metadata

| Evidence | What it means | Next investigation |
|---|---|---|
| Keyboard history has image; `primaryClipAccessible=false` while Preview is in focus | Clipboard may be private to Samsung Keyboard, cleared, or inaccessible | Test an ordinary Gallery Copy and a Share Sheet image; don't assume private history is readable |
| `observedEvents` did not change; `primaryClipAccessible=true` | Android monitor may not have seen the change | Background restriction, logcat/overlay permission, watcher status |
| Event `lastEventType=unavailable` or `access-error` | Callback fired but data was inaccessible | Focus/overlay path and Android privacy restrictions |
| `hasUri=true`, `detectedType=image`, `imageReadable=no` | Image URI detected, provider denies opening it | URI grants/provider scope and timing |
| `imageReadable=yes`; `lastTransportStage=js-image` | Native classification succeeded, but P2P send not shown | Size validation, DataChannel readiness, bridge exceptions |
| `lastTransportStage=p2p-image-pending` | No open DataChannel at send time | ICE recovery / network or VPN |
| `lastTransportStage=p2p-image-error` | Sender raised an error | Local status text + narrow redacted log review |
| `lastTransportStage=p2p-image-queued`, Paint still blank | Sender queued data; delivery/application is unproven | Compare Windows inbound fragment reassembly and Win32 CF_DIB write |

`lastEvent...` and `lastTransportStage` describe **the most recent events**, not a correlated receipt. The counters are in memory only, and may reset after process restarts. Do not submit clipboard content, original URI, full DATA file, or secrets.

## VPN/one-way reliability scope

This preview also attempts P2P reconnection after an ICE connection remains `disconnected` for 15 seconds. This is **not a VPN relay**. WebSocket signaling, STUN, transport paths, and potential VPN policies can still prevent a connection. A robust WSS relay-first design requires a capability-negotiated server/client implementation and tests with encrypted payloads, acknowledgments, retry and backpressure. Do not claim it exists today.

For field acceptance, toggle VPN on either device, monitor Peers/DataChannel recovery, and repeat image/text bidirectional tests. Keep raw content out of logs. Do not modify sync.world-honey.com until origin, capabilities and deployment rollback are verified.

## Auto-Sync Screenshots (new experimental feature)

The user's **actual Samsung S24 field test confirmed that Gallery → Share →
ClipCascade Preview → Windows Paint works**, while taking a screenshot only
left `text/plain` visible to the standard clipboard diagnostic. The P2P image
transport was proven end-to-end, so we must not break Windows 3.3.4 or depend
on Samsung Keyboard's private history.

- On the Preview connected screen, tap **Enable Auto-Sync Screenshots**.
- Android requires **Allow all photos** (READ_MEDIA_IMAGES on API 33+);
  selected-only access cannot guarantee watching images saved in the future.
- This feature is **off by default**. The persistent preference only takes
  effect while ClipCascade's foreground service is running. Stop turns the
  observer off. A later Start re-establishes a new high-water mark.
- The native MediaStore ContentObserver captures a baseline `_ID` BEFORE
  registering; image rows with older IDs are never uploaded. It checks for a
  `Screenshots/` path or conventional `Screenshot...` filename, waits for
  nonzero size and not-pending rows, and deduplicates repeated callbacks.
- Only new saved screenshot *URIs* enter the existing local Base64 → E2EE
  WebRTC P2P → Windows clipboard pipeline. No gallery scanning backlog.
  No image contents are written to the diagnostic report.
- This does not replicate arbitrary Samsung Keyboard image history, images
  copied from other apps, or screenshots that were not saved. It must be
  verified on a Samsung device with full photo permission. Background OEM
  policies may affect delivery timing.
- Under Inspect Clipboard, `screenshotMonitorActive` and
  `savedScreenshotEvents` are additional local-only counters. The primary
  clip's `detectedType` can remain `text` even when MediaStore auto-sync
  sends a saved screenshot; this is expected.

## VPN reality and verified/remaining work

This Preview also listens to both `connectionState` and
`iceConnectionState` for WebRTC transport loss and schedules a bounded
15-second recovery after disconnect. That can fix stale sessions or routing
changes **only when a viable candidate path still exists**. It does not
turn the existing STUN-only deployment into an effective VPN relay.

For restricted UDP/NAT/VPN connections, configure a privately controlled,
authenticated TURN service with UDP and TCP/TLS (e.g. coturn) and supply
`iceServers` to **both Android and Windows clients**; or implement a separate
authenticated, end-to-end-encrypted WSS clipboard relay with replay/idempotent
receipts and bounded buffers. The existing `sync.world-honey.com`
P2P signaling server is **not** automatically an application data relay.
No live server or stable Windows install has been changed in this PR.

See Android's MediaStore guidance and react-native-webrtc's
ImprovingCallReliability documentation for permission and TURN requirements.
