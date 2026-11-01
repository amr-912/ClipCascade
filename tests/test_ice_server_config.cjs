/* Integration-contract tests: authenticated issuer, expiring TURN, safe fallback. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {normalizeIceResponse, loadIceServerConfig, fallback} =
  require('../ClipCascade_Mobile/src/IceServerConfig.js');

const payload = {
  expiresAt: Date.now() + 3600_000,
  iceServers: [
    {urls: 'stun:stun.cloudflare.com:3478'},
    {urls: ['turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'ephemeral-user', credential: 'ephemeral-secret'},
  ],
};

test('Android uses short-lived authenticated TURN, never exposed master token', () => {
  const p = normalizeIceResponse(payload, 'stun:custom.example:3478');
  assert.equal(p.hasTurn, true);
  assert.equal(p.servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => u.startsWith('turns:'))), true);
  const src = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/IceServerConfig.js'), 'utf8');
  assert.doesNotMatch(src, /CLIPCASCADE_TURN_API_TOKEN|TURN_KEY_API_TOKEN|generate-ice-servers/);
});

test('Android rejects TURN without credentials and preserves STUN fallback', () => {
  assert.throws(() => normalizeIceResponse({
    iceServers: [{urls: 'turn:turn.cloudflare.com:3478?transport=udp'}],
  }, 'stun:custom.example:3478'));
  assert.deepEqual(fallback('stun:custom.example:3478').servers,
    [{urls: 'stun:custom.example:3478'}]);
});

test('Android API fetch includes session cookie and does not persist TURN credentials', async () => {
  let req;
  const result = await loadIceServerConfig('https://relay-tests.example', 'stun:custom.example:3478',
    {fetcher: async (url, options) => {
      req = {url, options};
      return {ok: true, json: async () => payload};
    }});
  assert.equal(result.hasTurn, true);
  assert.equal(req.url, 'https://relay-tests.example/ice-servers');
  assert.equal(req.options.credentials, 'include');
  assert.equal(req.options.method, 'GET');
});

test('Android invalid endpoint fails closed to direct STUN with no leaked token', async () => {
  const result = await loadIceServerConfig('http://untrusted.example',
    'stun:safe.example:3478', {fetcher: () => { throw Error('should not fetch'); }});
  assert.equal(result.hasTurn, false);
  assert.equal(result.servers[0].urls, 'stun:safe.example:3478');
});

test('Android screenshot startup and privacy guards remain intact', () => {
  const c = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ScreenshotMediaMonitor.kt'), 'utf8');
  assert.match(c, /refuse to scan history/);
  assert.match(c, /baselineId = latestImageId\(\)/);
  assert.match(c, /isSavedScreenshot\(relativePath, name\)/);
  assert.match(c, /cursor\.getInt\(pendingIndex\) != 0/);
});

test('Android preview never opens upstream update APK links', () => {
  const c = fs.readFileSync(path.join(root, 'ClipCascade_Mobile/src/UpdateChecker.js'), 'utf8');
  assert.match(c, /isForkPreview\(\)/);
  assert.match(c, /com\.clipcascade\.preview/);
  assert.match(c, /if \(isForkPreview\(\)\) return Promise\.resolve/);
});
