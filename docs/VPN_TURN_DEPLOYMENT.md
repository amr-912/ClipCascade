# VPN-resistant ClipCascade — TURN migration specification (no production activation)

Status: **architecture verified against the checked-in server, NOT deployed**.
Preserve existing encrypted P2P, original Android 3.3.0, stable Windows 3.3.4.

## Root cause verified in this repository

1. Android `StartForegroundService.js` constructs `RTCPeerConnection({iceServers:[{urls:stun_url}]})`; Windows `p2p_manager.py` constructs `RTCConfiguration(iceServers=[RTCIceServer(urls=[config.data["stun_url"]])])`.
2. Server `P2PWebSocketConfig.java` is active only when `app.p2p.enabled=true`. It exposes **signaling only** at `/p2psignaling`.
3. Server `StompWebSocketConfig.java` is active only when `app.p2p.enabled=false`. It exposes message relay at `/clipsocket`.
4. `ClipCascadeController.java` returns a mutually exclusive `P2P` or `P2S` mode and its STOMP handler explicitly returns if P2P is enabled.
5. **Therefore the running P2P server does not already offer a hidden WSS fallback for image data.** A client-only switch to `/clipsocket` cannot fix VPN. Preserving the current production mode is mandatory pending a tested backend change.

A working signaling WebSocket and `Peers: 0` implies no WebRTC data transport. A failing VPN/NAT/UDP path may need TURN. Short transient VPN route changes may be recovered by the ICE-state hooks in PR #2 but that is not the same as network relay.

## Safe TURN design (next deployable architecture)

Prefer a private, authenticated `coturn` on managed infrastructure or a managed TURN provider that issues **expiring TURN credentials**; do not configure open/anonymous TURN. Keep existing server account auth and E2EE.

- Expose STUN and TURN over UDP/TCP, and TURN-over-TLS (`turns:`) on a permitted port. Port 443 can be considered where infrastructure permits; check reverse-proxy conflicts with the existing HTTPS endpoint and actual carrier/VPN policies.
- Use TURN REST ephemeral credentials: `username=${expiryEpochSeconds}:${authenticatedUserId}`, `credential=base64(HMAC-SHA1(sharedTurnSecret, username))`, short TTL. The shared secret is **only** on the TURN service and authenticated backend; never in the app, Git, config logs or diagnostics.
- Add a strictly authenticated `GET /ice-servers` backend endpoint returning **only** currently usable ICE `urls`, short-lived username and credential, expiration and a capability marker. No static password in `/stun-url`.
- Android and Windows retrieve ICE config **on each new peer connection and recovery** (refresh before TTL), validate `stun:`, `turn:`, `turns:` URLs, fail closed to legacy STUN where the endpoint is absent, and never emit credentials to logs or screenshots.
- Include STUN for direct cheap paths, TURN/UDP where possible, TURN/TCP and TURN/TLS for constrained networks. ICE selects the usable route automatically; avoid tunneling clipboard data through a generic unauthenticated WebSocket.
- Keep encrypted clipboard payloads encrypted end-to-end inside WebRTC; TURN sees relayed packets, not decrypted clipboard content. Authenticate endpoints, enforce quotas, connection limits, client session expiry, abuse prevention and metrics.

## Suggested coturn server configuration template (not to copy verbatim to production)

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.invalid
fingerprint
use-auth-secret
# Set the secret at deployment from a secure secret manager.
# Do NOT commit static-auth-secret to Git.
no-cli
no-multicast-peers
no-loopback-peers
# Provide appropriate cert/pkey, external-ip, relay-ip and ports per host topology.
# Configure firewall for allocation relay ports; tune quotas and bandwidth.
```

**Verification gates before switching production:**

1. Confirm hosted TURN supports TCP/TLS and relaying over the user's actual VPN; verify DNS/certificate/firewall and relay port range.
2. Unit-test HMAC TTL issuance, authentication, origin/rate limiting and credential redaction; integration-test Android react-native-webrtc with Python aiortc.
3. Test direct STUN and forced relay ICE candidates in a staging server; verify images/text and anti-echo with both apps, as well as VPN toggling, roaming, interrupted large images, expiry refresh, bounded retries and acknowledgements.
4. Maintain the existing production server unchanged until a compatible dual-client release passes field tests; provide an immediate rollback of the TURN endpoint or capability flag.

## Alternate server relay

A WebSocket binary relay on the existing authenticated backend is an alternative but is **new server development**, not the existing `/p2psignaling`. It requires authenticated rooms, E2EE ciphertext-only messages, bounded fragmentation, expiry, receipts, duplicate suppression, server resource protection, and client capability negotiation. Do not mix it into the current signaling handler by routing arbitrary payloads.

## References

- Checked-in `P2PWebSocketConfig.java`, `StompWebSocketConfig.java`, `ClipCascadeController.java`
- WebRTC official introduction: https://webrtc.org/getting-started/peer-connections
- coturn official REST authentication: https://github.com/coturn/coturn/wiki/turnserver
- aiortc ICE/peer API: https://aiortc.readthedocs.io/en/latest/api.html

## Status ledger

**Implemented in Draft PR #2:** bounded ICE-recovery handling on Android/Windows, latest pending outbound clip in RAM, screenshot observer, tests, rollback documents.

**Not implemented/deployed:** authenticated TURN endpoint and server, dual-client ICE bootstrap, encrypted WSS payload relay, guaranteed receipt ACK, 100% VPN resilience, or Samsung acceptance of the latest screenshot-monitor build. The reason is infrastructure and physical network validation, not a proof that the architecture is impossible.
