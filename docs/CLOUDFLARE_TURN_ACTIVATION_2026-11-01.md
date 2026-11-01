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


## Operator runbook after TURN secrets and real Worker code deployed (2026-11-01)

Operator has reported completing creation and deployment of `clipcascade-turn-issuer` and adding the four production variables. This is operator-reported state, not verified through Cloudflare API. The Worker source now has explicit `validate-session` support and negative-case tests.

### Safe validation and route switch (one complete procedure)

1. Keep `raqim-clipboard-relay` on its current **Custom Domain** `sync.world-honey.com`; do not delete its secrets, Durable Object, domain or routes.
2. With variables in **Production** only, visit `https://clipcascade-turn-issuer.alamryamr000.workers.dev/ice-servers` in a private window. Expect **HTTP 401** with `{"error":"AUTH_REQUIRED"}` when the latest code and runtime secrets are active. This only proves the unauthenticated guard; it does NOT prove the TURN upstream or the relay's session verification.
3. Check unauthenticated `https://sync.world-honey.com/validate-session`: a non-2xx status demonstrates refusal; **404/405** indicates the actual endpoint/method differs and must be resolved BEFORE treating `CLIPCASCADE_AUTH_MODE=validate-session` as functional. Because our Worker calls GET with Cookie and `Accept: application/json`, an actual authenticated response must use the strict affirmative protocol (`OK` or JSON `{"valid":true}` or `{"authenticated":true,"status":"valid"}`). Never accept an arbitrary 200 or a login HTML page.
4. If and only if the old hostname is a Worker **Custom Domain** as shown in the dashboard, add a **Route** to `clipcascade-turn-issuer`, zone `world-honey.com`, exact pattern `sync.world-honey.com/ice-servers`; do **NOT** use wildcard `sync.world-honey.com/*`, and do **NOT** add a second Custom Domain for the same hostname. The original Worker remains behind the path route and handles other routes, including signaling and authentication.
5. Smoke test `https://sync.world-honey.com/ice-servers` with no login: must be 401 and JSON `AUTH_REQUIRED`. Verify `/p2psignaling`, `/login` and authenticated `/validate-session` are unaffected (no secret logging).
6. With a valid existing ClipCascade login session, the client GET `/ice-servers` must return **HTTP 200** JSON `iceServers` including short-lived TURN `username`/`credential` and `expiresAt`. Never publish or paste this JSON. HTTP 401 means authentication mismatch; 503 means TURN credentials unconfigured, upstream unavailable, or ambiguous origin/auth. Do not silently disable auth to get 200.
7. Pair Android Preview and Windows portable Preview built from same **latest commit**; the previous successful artifact commit `36f959...` is not the latest after auth source edits. Build and verify latest commit before physical testing. Test both VPN directions and forced relay where peer-direct traffic is prohibited; `TURN available` status is only config, not proof of relay.
8. Rollback by removing **only the new Route**, preserving the preexisting Custom Domain and all original services; the previews revert to STUN-only.

### Cloudflare docs

- More specific **Route** before an existing Worker **Custom Domain**: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Worker route precedence: https://developers.cloudflare.com/workers/configuration/routing/routes/
- Short-lived TURN credential API, provider returns 201 internally: https://developers.cloudflare.com/realtime/turn/generate-credentials/

### Security note

Earlier screenshot exposed a fragment of the long-term TURN Bearer token in a curl example. Rotate before treating it as production-grade, and put the new token only in the Worker Production secret. Worker tests ensure unauthorized requests do not mint credentials, but published rate limiting and actual session verification are still operational acceptance criteria.

## Routing correction verified against official Cloudflare matching rules

On 2026-11-01 the production route was shown as `sync.world-honey.com/ice-servers` (no terminal `*`) in the Cloudflare dashboard. The operator then ran a `curl` diagnostic including `?check=<nonce>`, which returned HTTP 200 `Raqim Clipboard Relay`. This is **expected to bypass the no-star route**: Cloudflare includes query strings when matching Worker route patterns and requires a final `*` for query-string requests. Source: https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior

**Correct dashboard Route:** `sync.world-honey.com/ice-servers*` on worker `clipcascade-turn-issuer`, zone `world-honey.com`. This prefix pattern also routes unrelated suffix paths to the Worker, so `worker.mjs` independently rejects any pathname other than `/ice-servers` with 404. A tested query `/ice-servers?check=12345` should receive unauthorized HTTP 401 without a session. **Never** use zone-wide wildcards such as `*.world-honey.com/*`.

This explains the query-bearing PowerShell result. However, the operator also reported `Raqim Clipboard Relay` when visiting the bare path with no query; that separate observation is **not conclusively explained** by the nonce mismatch and must be retested after updating the route. If bare path still returns old Worker output, check worker invocation logs, deployment status, other more-specific routes, and route ordering before changing production.

Do not confuse receiving a 401 for unauthenticated requests with a successful TURN session: a valid logged-in Client must receive time-limited `iceServers` from Cloudflare, and the VPN tests must verify relay usage.
