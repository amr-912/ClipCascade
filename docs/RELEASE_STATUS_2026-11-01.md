# ClipCascade: actual install and release state — 2026-11-01

## Decision now

**DO NOT REPLACE** the user's working Windows 3.3.4 with the newly announced upstream 3.4.1 until interoperability and image regression tests are done. Do not uninstall official Android 3.3.0 or the side-by-side experimental Android `com.clipcascade.preview`.

**The new screenshot-auto-sync APK HAS NOT BEEN BUILT OR TESTED ON SAMSUNG.** The old Preview artifact from GitHub run 40972020128, SHA 68211fa3e998239d606ba410913b1657605039d3 (Oct 29), predates `ScreenshotMediaMonitor.kt`. Never re-label that APK as the new screenshot Preview.

The source code for saved-Samsung-screenshot -> Windows auto-sync is backed up in this repository. It uses an explicit photo-access opt-in, monitors only newly indexed saved screenshots through Android MediaStore, and sends through the existing encrypted image transport. Samsung Gallery -> Share -> Preview -> Windows Paint **already passed a physical device test**; automatic screenshot detection with the new implementation has not.

## Upstream 3.4.1 (separate codebase)

Upstream published `v3.4.0` and `v3.4.1` on **2026-11-01**, after this fork's experimental branches were created.
Official upstream releases: https://github.com/Sathvik-Rao/ClipCascade/releases/tag/v3.4.1

- Upstream `v3.4.1` fixes a `v3.4.0` P2P regression: rebuilding failed transport even if DataChannel still reports open.
- `v3.4.0` adds improved reconnection, Android sharing/permission handling and send/receive controls.
- These are **not** our Android MediaStore implementation and are **not** a confirmed TURN/WSS relay. Do not confuse automatic update dialog 3.4.1 with our custom APK.
- Before contributing upstream, rebase small isolated PRs against upstream 3.4.1/main and run cross-version tests. Do not blindly merge the October fork work as one giant PR.

## Release gate and one external action

A manual GitHub Actions workflow is committed to the default branch:
https://github.com/amr-912/ClipCascade/actions/workflows/clipcascade_preview_artifact.yml

The user needs to sign into GitHub and click **Run workflow**:
- Workflow ref **main** (where the dispatch workflow file lives)
- `source_branch`: **test/screenshot-preview-release-2026-10-30**
- Run.

The GitHub connector available to this assistant can read the resulting Actions run and download artifacts but does **not** expose an API to dispatch a fresh workflow run.

The workflow is guarded on JS tests, Android Kotlin/Robolectric tests, Windows Python tests on Ubuntu and Windows, then APK assembly. Successful artifact: `ClipCascade-Android-Screenshot-AutoSync-Preview`. The artifact contains `ClipCascade-Preview-Bidirectional.apk`, `BUILD_INFO.txt` and `SHA256SUMS.txt`. The artifact's `source_commit` must match the selected branch head. **No CI run after 2026-10-29 appears in this fork's Actions history as of this audit.**

After a passing build, INSTALL **ANDROID ONLY** as the existing side-by-side `com.clipcascade.preview`; preserve the stable Windows 3.3.4 and Android official installation. Enable auto screenshot sync only with consent and **Allow all photos**, test a newly saved Samsung screenshot without Share, verify Windows Paint paste, and test both previously working directions and stop/restart. Any failure means not release-ready.

## VPN truth

Current cloud `sync.world-honey.com` endpoint is signaling over WebSocket for direct WebRTC **P2P**; no physical user-hosted server is required for signaling but STUN-only is not a reliable route through all VPN/firewall topologies. Existing code has ICE disconnect/reconnect improvements; do not call this a full VPN fix.

Cloudflare Realtime TURN is an independent managed relay option, **not configured**:
https://developers.cloudflare.com/realtime/turn/generate-credentials/

It needs a provisioned TURN key, an authenticated server-side issuer for expiring credentials, negotiation on both Android and Windows, credential rotation, ICE restart, and real constrained-network verification. Keep the long-term TURN secret out of Git/client builds. Do not alter the live signaling server or Windows client without a tested rollback.

## Audit evidence and links

- Current Android screenshot implementation PR: https://github.com/amr-912/ClipCascade/pull/2
- Release validation & startup ordering PR: https://github.com/amr-912/ClipCascade/pull/4
- Original Windows clipboard fix: https://github.com/amr-912/ClipCascade/pull/1
- Previous successful but **old** Android artifact workflow: https://github.com/amr-912/ClipCascade/actions/runs/40972020128
- Engineering acceptance contract: `docs/RELEASE_READINESS_AND_UPSTREAM.md`

No production install, new APK generation, automatic cloud deployment, or VPN relay provisioning is claimed by this document.
