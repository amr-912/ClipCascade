# ClipCascade — unified engineering closure and upstream quality gates

**Status: NOT PRODUCTION RELEASED.** Source is retained on GitHub. Do not install
an October/early-November Preview as if it contains all the fixes below, or
replace Windows 3.3.4 merely because an upstream 3.4.1 popup appears.

## Evidence ledger: what has and has not been proved

| Requirement | Actual implementation | Automated evidence | Hardware/production status |
| --- | --- | --- | --- |
| Windows screenshot -> Samsung | Fork Windows 3.3.4 clipboard listeners | Windows P2P regression | **Previously succeeded** on Dell/S24 |
| Samsung text -> Windows | Android listener + P2P transport | JS and Windows transports | **Previously succeeded** |
| Samsung Gallery Share -> Windows image | Native image URI Base64 -> P2P -> Windows clipboard | Android bridge tests | **Previously succeeded** on S24/Windows |
| *Newly saved* Samsung screenshot without Share | Opt-in `ScreenshotMediaMonitor.kt` on Android MediaStore | Kotlin/Robolectric + JS transport, GitHub CI | **Not yet tested on actual Samsung with the latest build** |
| Background observer privacy | Explicit opt-in, full-photo permission, no historical backfill; baseline query fails closed | Screenshot eligibility, startup and permissions | Android 14+ partial vs full access field test pending |
| Temporary VPN disconnect/reconnect | Existing Android/Windows ICE-state recovery, heartbeat, bounded pending copy and peer setup serialization | JS / Python platform regression | No guaranteed route if direct traffic blocked |
| **VPN/NAT where STUN cannot connect** | Authenticated TURN credential issuer (Spring **or** optional Cloudflare Worker); both clients fetch short-lived credentials; desktop prefers `turns:...`:443 | Unit tests for Windows/Android/Worker/Spring | **Not operational until TURN account secret is provisioned and issuer is deployed** |
| End-to-end receipt acknowledgement | Not implemented | No genuine delivery-ACK test | **Not guaranteed**; `queued` is NOT `received` |
| Upstream update notice separation | Android/Windows fork Preview ignores incompatible upstream release prompts | Unit/source CI | Official upstream installations unchanged |
| Server authenticated session | Existing Spring `/whoami`, required for optional Worker validation | Worker rejects invalid sessions, redirects | User session lifetime/network conditions still require field verification |

## Restore source code after device loss

`git clone https://github.com/amr-912/ClipCascade.git`
`cd ClipCascade`
`git checkout test/screenshot-preview-release-2026-10-30`

Draft PR #4 contains this release-validation track; draft PR #2 contains the
underlying Android/Windows clipboard fixes. All implementation, scripts,
deployment templates and automated regression tests are retained on GitHub.
Do not store passwords, JSESSIONID cookies, Cloudflare TURN API tokens,
screenshots, clipboard text or secret files in Git.

## Managed TURN without any user-owned physical server

Primary cloud-only option: deploy the isolated Worker in
`cloudflare/turn-issuer/` only on the exact `/ice-servers` path on the
**existing** Cloudflare-proxied ClipCascade host. The Worker forwards the
request's login cookie to the existing authenticated `/whoami`, requiring
status 200 and a username before issuing short-lived Realtime TURN tokens.
The Cloudflare TURN long-term key is stored only in Worker Secrets.

Operator-only (requires account and authorization):
1. Provision a Cloudflare Realtime TURN key: https://developers.cloudflare.com/realtime/turn/
2. Set Worker secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` in Cloudflare securely.
3. Configure `CLIPCASCADE_AUTH_ORIGIN` to the HTTPS application origin that
   handles existing sessions (default template: `https://sync.world-honey.com/`).
4. Deploy only the route `sync.world-honey.com/ice-servers*` using
   `cloudflare/turn-issuer/wrangler.toml`. **Do not replace the signaling
   WebSocket route or expose the worker on a public wildcard.**
5. Ensure authenticated GET `/ice-servers` returns short-lived `iceServers`
   with TURN over TLS on TCP 443, while unauthenticated access returns 401.
6. Protect issuer route with Cloudflare WAF / rate limits for metered TURN usage.
   Do not paste the long-lived token into chat, code, GitHub CI or user logs.

Alternate server-backed approach: compile/deploy the new authenticated Spring
`IceServersController` and set the same TURN env variables there. **Choose one
issuer route; do not deploy conflicting Spring/Worker endpoints.**

Official ephemeral credential contract:
https://developers.cloudflare.com/realtime/turn/generate-credentials/

Android uses session-authenticated fetch to obtain ICE servers (RAM cache).
Windows selects TLS/TCP 443 first from Cloudflare's available list because
aiortc can only use one TURN candidate. When the issuer is unconfigured both
clients retain direct STUN connectivity; **that is not VPN universal support**.

## Delivery + release blockers (do not skip)

- CI must pass on the **exact latest source SHA**: JS transport and Worker
  security; Windows P2P tests on both Windows/Ubuntu; Java 21 TURN issuer unit
  tests; Android Kotlin/Robolectric and preview APK; Windows portable EXE.
- Inspect GitHub artifact BUILD_INFO and hashes; do not reuse an artifact
  from an older commit that predates a fix. Artifacts expire.
- The current live server must successfully return temporary TURN credentials
  to authenticated clients; verify rejected requests, rotation and TTL.
- Run Wi-Fi with VPN off/on, hotspot, UDP-blocking firewall, switch networks
  while transferring an image, disconnect/reconnect both peers, expired TURN
  credential renewal, and text/image bidirectional regressions.
- On Samsung test a *NEW* screenshot without opening Gallery/Share, confirm
  Paint paste and counters; confirm ordinary camera/gallery photos never
  auto-transfer and disabling feature revokes monitoring.
- Test first launch, restart, OS battery optimization, airplane mode, app
  restart, session expiry and mixed-version rollback.
- For full reliability add an application-level receipt ACK with bounded
  retransmission/deduplication. P2P `send()` alone is not receipt.
- Preserve existing stable Windows 3.3.4 and Android official app; Preview
  artifacts are separately signed or portable and do not replace either.
- **No patch to main or upstream PR while any gate is missing.** Upstream
  contributions must be separate: Windows clipboard, Android privacy-based
  saved screenshots, P2P reliability, portable TURN issuer/API, clients.

## Version & updater isolation

The upstream official 3.4.1 (2026-11-01) is separate from our custom Preview.
The updater's notification alone does not prove it caused login loss.
Fork Preview suppresses upstream update prompts, but the stable installed
Windows 3.3.4 is not modified. Do not disable security updates in upstream
distributions by default, and don't hardcode fork domains in generic upstream PRs.

## Minimum acceptance artifact

A successful, verified APK *and* a portable Windows Preview built from the
same source commit, accompanied by CI results, a read-only test checklist,
a tested cloud TURN route and a rollback procedure. After passing private
network and Samsung acceptance, freeze a tag and release. Until then, source
preservation and green unit tests are not production proof.
