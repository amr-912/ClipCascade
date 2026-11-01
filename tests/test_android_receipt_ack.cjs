/* Runs the genuine Android receive callback with a fake DataChannel. */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ClipCascade_Mobile/src/StartForegroundService.js'), 'utf8');
const start = source.indexOf('          const onDataChannelMessage = async (messageJson, remotePeerId = null, channel = null) => {');
const end = source.indexOf('\n          /**\n           * The server gave us', start);
assert.ok(start >= 0 && end > start, 'real Android receiver must be present');
const receiverSource = source.slice(start, end);

function harness() {
  const applied = [];
  let allowApply = true;
  let lastHash = '';
  const ctx = {
    JSON, String, Date,
    clearFiles: async () => {},
    p2pMsg: '',
    ackCapablePeers: new Set(),
    pendingAcknowledgements: {},
    clearPeerAck: peer => {delete ctx.pendingAcknowledgements[peer]},
    noteClipboardStage: () => {},
    p2pStatusMessageChanged: async () => {},
    max_clipboard_size_local_limit_bytes: -1,
    cipher_enabled: 'false',
    resetReceivingFragments: async () => {},
    hashCB: async data => data,
    newCB: async hash => hash !== lastHash,
    validateClipboardSize: async () => true,
    Clipboard: {setString: async s => {
      if (!allowApply) throw Error('clipboard write failed');
      applied.push({type: 'text', data: s});
    }},
    NativeBridgeModule: {copyBase64ImageToClipboardUsingCache: async b => {
      if (!allowApply) throw Error('native refused invalid image');
      applied.push({type: 'image', data: b});
    }},
  };
  Object.defineProperty(ctx, 'previous_clipboard_content_hash', {
    get: () => lastHash, set: h => {lastHash = h}, configurable: true,
  });
  vm.createContext(ctx);
  vm.runInContext(receiverSource + '\nthis.receive = onDataChannelMessage;', ctx);
  const channel = {readyState: 'open', sent: [],
    send(s) {this.sent.push(JSON.parse(s))}};
  return {
    ctx, channel, applied, setAllow: v => {allowApply = v},
    copy: (id, payload = 'image-base64') => ctx.receive(JSON.stringify({
      type: 'image', payload,
      metadata: {id, isFragmented: false, combinedRawPayloadSizeInBytes: 12},
    }), 'windows', channel),
    negotiate: () => ctx.receive(JSON.stringify({
      _cc_keepalive: true, ackProtocol: 1,
    }), 'windows', channel),
  };
}

test('Android negotiates receipt ACK without altering clipboard on keepalive', async () => {
  const h = harness();
  await h.negotiate();
  assert.equal(h.applied.length, 0);
  assert.equal(h.ctx.ackCapablePeers.has('windows'), true);
});

test('Android only acknowledges a successfully applied image', async () => {
  const h = harness();
  await h.negotiate();
  h.setAllow(false);
  await h.copy('msg-one');
  assert.equal(h.channel.sent.length, 0);
  h.setAllow(true);
  await h.copy('msg-one');
  assert.equal(h.applied.length, 1);
  assert.equal(h.channel.sent.length, 1);
  assert.equal(h.channel.sent[0]._cc_ack, 'msg-one');
});

test('Android idempotently acknowledges resent image without recopying it', async () => {
  const h = harness();
  await h.negotiate();
  await h.copy('id-one');
  await h.copy('id-two');
  assert.equal(h.applied.length, 1);
  assert.equal(h.channel.sent.length, 2);
  assert.equal(h.channel.sent[1]._cc_ack, 'id-two');
});

test('Android does not send unsolicited ACK to legacy peer', async () => {
  const h = harness();
  await h.copy('old-client');
  assert.equal(h.applied.length, 1);
  assert.equal(h.channel.sent.length, 0);
});
