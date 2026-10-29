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
