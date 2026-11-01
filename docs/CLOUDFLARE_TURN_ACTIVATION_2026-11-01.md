# ClipCascade — TURN account created, deployment not yet authorized (2026-11-01)

## Verified external facts
- Operator created a Cloudflare **Realtime TURN Server** key (NOT Realtime SFU) in Cloudflare's dashboard. The key's own create-credentials page displayed TURN Token ID and API Token.
- Cloudflare TURN credentials API: POST `https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers` with `Authorization: Bearer {TURN_KEY_API_TOKEN}`, `Content-Type: application/json`, and e.g. `{"ttl":3600}`. Official success: HTTP **201**, JSON `iceServers` with STUN URLs and short-lived TURN user/credential. See https://developers.cloudflare.com/realtime/turn/generate-credentials/
- **No TURN master token was added to GitHub or either client.** The dashboard screenshot includes a partial bearer-token view in its example curl. Rotate the master key before production use.
- Existing independent Worker **raqim-clipboard-relay** has `CC_USERNAME`, `CC_PASSWORD_HASH`, `RELAY_TOKEN`, `SESSION_SECRET` and `CLIPBOARD_ROOM`. Those bindings are not compatible evidence of the original Spring `/whoami` and `JSESSIONID` contract. Never alter this Worker to install TURN issuer without auditing its actual authentication protocol.
- Fork CI passed on `36f959ca0350678c4e0a8ea135352db0f14ab699` with APK and portable Windows EXE. Neither is verified with deployed TURN on real VPN networks.

## Correct deployment target (isolated)
- Use standalone Worker **clipcascade-turn-issuer**, source `cloudflare/turn-issuer/worker.mjs` and `wrangler.toml` in this repository. **Do not modify** `raqim-clipboard-relay` or delete its secrets/DOs.
- In new Worker **Settings → Variables and Secrets → Production**, store:
  - `TURN_KEY_ID` → **Secret**: TURN Token ID from TURN dashboard.
  - `TURN_KEY_API_TOKEN` → **Secret**: long-term TURN API token.
  - `CLIPCASCADE_AUTH_ORIGIN` → **Text**: verified HTTPS URL of the actual server implementing `/whoami` with authenticated `JSESSIONID`. For the current source template: `https://sync.world-honey.com/` — **not a verified deployment assertion**.
- No secret in `wrangler.toml`, GitHub, screenshots, chat or client config.

## Pre-deployment verification (hard gate)
1. Identify which service ACTUALLY receives the Android and Windows `server_url` login and `/whoami` routes. Do not assume it is `raqim-clipboard-relay` because the Worker was shown in the dashboard.
2. Verify `/whoami` authenticates a valid `JSESSIONID` and returns JSON containing nonempty `username`; invalid cookie must not succeed. The Worker code sends the incoming session cookie to this endpoint and rejects redirects.
3. Verify `sync.world-honey.com` is a Cloudflare-proxied hostname in the intended zone and the route `sync.world-honey.com/ice-servers*` does not conflict with an existing **Worker Custom Domain** or route. Per https://developers.cloudflare.com/workers/configuration/routing/routes/ route specificity/custom-domain behavior must be examined before deployment.
4. Deploy only the isolated `/ice-servers` endpoint after (1–3). Do NOT move the signaling WebSocket, touch `/whoami`, or replace the root route.
5. Test without logging secrets: GET `/ice-servers` unauthenticated => 401; with legitimate login cookie => 200 containing `iceServers` and expiry; Cloudflare provider HTTP 201 internally; reject login redirect. WAF/rate limiting is required on this billed credential minting endpoint.
6. Test phone and Windows clients with different VPN/firewall conditions and confirm a relay ICE candidate actually wins rather than merely the configuration showing `TURN available`. Verify message ACK, Screenshot auto-sync, reconnect, token expiry, stop/restart, and zero regressions.
7. Rollback: delete/disable **only** the isolated `/ice-servers*` Worker route, not the existing proxy, signaling host or `raqim-clipboard-relay`; clients fall back to STUN-only and existing stable versions remain installed.

## Do not claim
- A TURN key alone is not a working VPN fix.
- GitHub CI alone is not Galaxy S24 / VPN acceptance.
- TURN is metered without Cloudflare Realtime SFU, see https://developers.cloudflare.com/realtime/turn/
- The SFU app credential that was previously shared is not a TURN key and should be rotated/revoked separately.

## Current decision required from operator
**Only** deploy the isolated Worker and enter secrets through Cloudflare's secret input once verified auth and routing are ready; no private tokens should be sent in this conversation.
