import {test} from 'node:test';
import assert from 'node:assert/strict';
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
