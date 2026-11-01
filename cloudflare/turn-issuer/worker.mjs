/**
 * Optional Cloudflare Worker route: /ice-servers on the existing ClipCascade
 * domain. It is a credential issuer, NOT a clipboard relay or signaling server.
 * Production deployment requires an operator to provision Cloudflare Realtime
 * TURN, configure the route, and store both values as Worker secrets.
 *
 * Security: fail closed; validate existing Spring user session via /whoami,
 * disallow cross-origin requests and redirects, no cache or master-key logs.
 * Never deploy this on a wildcard route that intercepts /whoami itself.
 */
const noStore = {'Cache-Control': 'no-store', 'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff'};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: noStore});

export async function issueIceServers(request, env, fetcher = fetch) {
  if (request.method !== 'GET') return json({error: 'METHOD_NOT_ALLOWED'}, 405);
  const url = new URL(request.url);
  if (url.pathname !== '/ice-servers') return json({error: 'NOT_FOUND'}, 404);
  if (url.protocol !== 'https:') return json({error: 'HTTPS_REQUIRED'}, 403);

  const key = env?.TURN_KEY_ID || '';
  const token = env?.TURN_KEY_API_TOKEN || '';
  const origin = env?.CLIPCASCADE_AUTH_ORIGIN || '';
  let authOrigin;
  try {
    authOrigin = new URL(origin);
    if (authOrigin.protocol !== 'https:' || authOrigin.username ||
        authOrigin.password || !authOrigin.hostname || authOrigin.pathname !== '/')
      throw new Error('Bad origin');
  } catch (_) {
    return json({available: false, reason: 'ISSUER_NOT_CONFIGURED'}, 503);
  }
  if (!/^[\w-]{1,128}$/.test(key) || typeof token !== 'string' ||
      !token.length) {
    return json({available: false, reason: 'ISSUER_NOT_CONFIGURED'}, 503);
  }

  const cookie = request.headers.get('Cookie');
  if (!cookie || cookie.length > 4096 ||
      !/(?:^|;\s*)JSESSIONID=[^;\s]+/.test(cookie)) {
    return json({error: 'AUTH_REQUIRED'}, 401);
  }

  try {
    // Auth check uses the same ClipCascade server session, not a second
    // static token. Never follow redirects to a login page as a valid user.
    const authUrl = new URL('/whoami', authOrigin);
    const auth = await fetcher(authUrl.toString(), {
      method: 'GET', redirect: 'manual',
      headers: {'Cookie': cookie, 'Accept': 'application/json'},
      cache: 'no-store',
    });
    if (auth.status !== 200) return json({error: 'AUTH_REQUIRED'}, 401);
    const identity = await auth.json();
    if (!identity || typeof identity.username !== 'string' ||
        !identity.username.length) return json({error: 'AUTH_REQUIRED'}, 401);

    const credentialUrl = 'https://rtc.live.cloudflare.com/v1/turn/keys/' +
      encodeURIComponent(key) + '/credentials/generate-ice-servers';
    const turn = await fetcher(credentialUrl, {
      method: 'POST',
      headers: {'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({ttl: 3600}),
      cache: 'no-store',
    });
    if (turn.status !== 201) {
      return json({available: false, reason: 'TURN_UNAVAILABLE'}, 503);
    }
    const credentials = await turn.json();
    if (!Array.isArray(credentials?.iceServers) ||
        !credentials.iceServers.some(x =>
          x && x.username && x.credential &&
          (Array.isArray(x.urls) ? x.urls : [x.urls])
            .some(u => typeof u === 'string' && /^turns?:/.test(u)))) {
      return json({available: false, reason: 'TURN_RESPONSE_INVALID'}, 503);
    }
    return json({iceServers: credentials.iceServers,
      expiresAt: Date.now() + 3600_000, provider: 'managed-turn'});
  } catch (_) {
    return json({available: false, reason: 'ISSUER_TEMPORARILY_UNAVAILABLE'}, 503);
  }
}

export default {fetch: (request, env) => issueIceServers(request, env)};
