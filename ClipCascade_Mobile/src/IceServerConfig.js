'use strict';

// Short-lived ICE credentials are obtained only from an authenticated server.
// Do not persist them in AsyncStorage, print them, or ship a TURN master token.
const CACHE_GUARD_MS = 5 * 60 * 1000;
const FAILED_RETRY_MS = 20 * 1000;
let cache = null;
let inFlight = null;
let inFlightKey = null;

const isIceUri = u => typeof u === 'string' && u.length < 300 &&
  /^(stun|stuns|turn|turns):[^\s]+$/i.test(u);

const normalizeIceResponse = (payload, stunUrl) => {
  if (!payload || !Array.isArray(payload.iceServers)) {
    throw new Error('No ICE server list');
  }
  const servers = [];
  let hasTurn = false;
  for (const raw of payload.iceServers.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const urls = (Array.isArray(raw.urls) ? raw.urls : [raw.urls])
      .filter(isIceUri).slice(0, 10);
    const turn = urls.filter(url => /^(turn|turns):/i.test(url));
    const stun = urls.filter(url => /^(stun|stuns):/i.test(url));
    if (stun.length) servers.push({urls: stun});
    if (turn.length && typeof raw.username === 'string' &&
        typeof raw.credential === 'string' &&
        raw.username.length > 0 && raw.credential.length > 0 &&
        raw.username.length <= 512 && raw.credential.length <= 512) {
      hasTurn = true;
      servers.push({urls: turn, username: raw.username,
        credential: raw.credential});
    }
  }
  if (stunUrl && isIceUri(stunUrl) && /^stun:/i.test(stunUrl) &&
      !servers.some(server => server.urls.includes(stunUrl))) {
    servers.unshift({urls: stunUrl});
  }
  if (!hasTurn) throw new Error('No usable TURN credentials');
  return {servers, hasTurn};
};

const fallback = stunUrl => ({
  servers: isIceUri(stunUrl) && /^stun:/i.test(stunUrl) ? [{urls: stunUrl}] : [],
  hasTurn: false,
});

// One in-flight request per process. Never store credentials on disk.
const loadIceServerConfig = async (serverUrl, stunUrl, opts = {}) => {
  const clock = opts.now || Date.now;
  const request = opts.fetcher || fetch;
  const now = clock();
  if (cache && cache.url === serverUrl && cache.stun === stunUrl &&
      now < cache.until) return cache.result;
  // A concurrent login/server switch must never reuse another origin's ICE
  // credentials. Dedupe only requests for this exact endpoint and STUN.
  const requestKey = JSON.stringify([serverUrl, stunUrl]);
  if (inFlight && inFlightKey === requestKey) return inFlight;
  const flight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      if (!/^https:\/\//i.test(serverUrl || '') &&
          !/^http:\/\/localhost(?::\d+)?$/i.test(serverUrl || '')) {
        throw new Error('ICE endpoint requires HTTPS');
      }
      const response = await request(serverUrl.replace(/\/$/, '') + '/ice-servers',
        {method: 'GET', credentials: 'include',
          headers: {'Accept': 'application/json'}, signal: controller.signal});
      if (!response.ok) throw new Error('TURN not provisioned');
      const payload = await response.json();
      const result = normalizeIceResponse(payload, stunUrl);
      const expiry = Number(payload.expiresAt);
      // A stale or missing issuer expiry is not a usable TURN allocation.
      // Failing closed to STUN is better than advertising broken VPN relay.
      if (payload.expiresAt == null || !Number.isFinite(expiry) ||
          expiry <= now + CACHE_GUARD_MS) {
        throw new Error('TURN credentials expired or expiry missing');
      }
      const maxUntil = now + 45 * 60 * 1000;
      const until = Math.min(maxUntil, expiry - CACHE_GUARD_MS);
      cache = {url: serverUrl, stun: stunUrl, until, result};
      return result;
    } catch (_) {
      const result = fallback(stunUrl);
      cache = {url: serverUrl, stun: stunUrl,
        until: now + FAILED_RETRY_MS, result};
      return result;
    } finally {
      clearTimeout(timer);
    }
  })();
  const tracked = flight.finally(() => {
    // Completion of the old request must not clear a newer in-flight one.
    if (inFlight === tracked) {
      inFlight = null;
      inFlightKey = null;
    }
  });
  inFlightKey = requestKey;
  inFlight = tracked;
  return tracked;
};

module.exports = {normalizeIceResponse, loadIceServerConfig, fallback};
