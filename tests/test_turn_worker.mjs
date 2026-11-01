import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {issueIceServers} from '../cloudflare/turn-issuer/worker.mjs';

const env = {TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'server-secret',
  CLIPCASCADE_AUTH_ORIGIN: 'https://sync.example/'};

const request = (cookie = 'JSESSIONID=valid-session') =>
  new Request('https://sync.example/ice-servers',
    {method: 'GET', headers: {Cookie: cookie}});

test('Cloudflare TURN Worker refuses missing authentication without calling API', async () => {
  const res = await issueIceServers(request(''), env, () => {
    throw Error('network must not be reached');
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('Cloudflare TURN Worker verifies session before obtaining 1h ephemeral key', async () => {
  const calls = [];
  const res = await issueIceServers(request(), env, async (url, opts) => {
    calls.push({url, opts});
    if (url.endsWith('/whoami'))
      return {status: 200, json: async () => ({username: 'tester'})};
    return {status: 201, json: async () => ({iceServers: [
      {urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'temp-user', credential: 'temp-password'}]})};
  });
  assert.equal(res.status, 200);
  const obj = await res.json();
  assert.equal(obj.iceServers[0].username, 'temp-user');
  assert.equal(calls[0].url, 'https://sync.example/whoami');
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(calls[0].opts.headers.Cookie, 'JSESSIONID=valid-session');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer server-secret');
  assert.equal(JSON.parse(calls[1].opts.body).ttl, 3600);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('Cloudflare TURN Worker refuses login redirects and never calls Cloudflare', async () => {
  let called = 0;
  const res = await issueIceServers(request(), env, async () => {
    called++;
    return {status: 302, headers: {'Location': '/login'}};
  });
  assert.equal(res.status, 401);
  assert.equal(called, 1);
});

test('Cloudflare TURN Worker returns 503 if secrets missing', async () => {
  const res = await issueIceServers(request(), {...env, TURN_KEY_API_TOKEN: ''},
    () => {throw Error('never');});
  assert.equal(res.status, 503);
});

test('Cloudflare TURN Worker avoids reflecting cloud errors or master key', async () => {
  const res = await issueIceServers(request(), env, async url => {
    if (url.endsWith('/whoami'))
      return {status: 200, json: async () => ({username: 'tester'})};
    return {status: 503, json: async () => ({secret: 'never expose'})};
  });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.doesNotMatch(body, /server-secret|never expose/);
});

test('Cloudflare TURN Worker rejects unsafe auth origin configuration', async () => {
  const res = await issueIceServers(request(), {...env,
    CLIPCASCADE_AUTH_ORIGIN: 'http://sync.example/'}, () => {throw Error('never');});
  assert.equal(res.status, 503);
});


test('legacy Cloudflare relay validates an affirmative session result before TURN', async () => {
  const calls = [];
  const res = await issueIceServers(request(), {
    ...env, CLIPCASCADE_AUTH_MODE: 'validate-session',
  }, async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/validate-session'))
      return {status: 200, text: async () => JSON.stringify({valid: true})};
    return {status: 201, json: async () => ({iceServers: [{
      urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'temporary-user', credential: 'temporary-secret',
    }]})};
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0], 'https://sync.example/validate-session');
  assert.equal(calls.length, 2);
});

test('a 200 login HTML, a false session, and arbitrary 200 text never mint TURN', async () => {
  for (const fakeSession of ['<html>Login</html>', '{"valid":false}', 'authenticated',
                             '{"status":"valid"}', '{"authenticated":true}']) {
    let cloudCalls = 0;
    const res = await issueIceServers(request(), {
      ...env, CLIPCASCADE_AUTH_MODE: 'validate-session',
    }, async (url) => {
      if (url.endsWith('/validate-session'))
        return {status: 200, text: async () => fakeSession};
      cloudCalls++;
      throw Error('should not mint credentials');
    });
    assert.equal(res.status, 401, fakeSession);
    assert.equal(cloudCalls, 0, fakeSession);
  }
});

test('invalid authentication mode must fail closed without using provider', async () => {
  const res = await issueIceServers(request(), {...env,
    CLIPCASCADE_AUTH_MODE: 'trust-200'}, () => {
    throw Error('network must not be reached');
  });
  assert.equal(res.status, 503);
});


test('query string preserves exact issuer pathname and rejects other route-prefix paths', async () => {
  const noCall = () => { throw Error('No provider call before authentication'); };
  const query = new Request('https://sync.example/ice-servers?check=12345');
  const response = await issueIceServers(query, env, noCall);
  assert.equal(response.status, 401);
  const forbidden = new Request('https://sync.example/ice-servers-unrelated');
  const notFound = await issueIceServers(forbidden, env, noCall);
  assert.equal(notFound.status, 404);
});

test('Cloudflare Worker route matches URI query strings; handler remains exact-path only', () => {
  const config = fs.readFileSync(new URL('../cloudflare/turn-issuer/wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /pattern\s*=\s*"sync\.world-honey\.com\/ice-servers\*"/);
});
