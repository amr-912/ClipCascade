/* eslint-env node */
'use strict';

// Exercises the actual Android send function extracted from StartForegroundService,
// using a fake DataChannel. No React Native runtime or Android device is required.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ClipCascade_Mobile/src/StartForegroundService.js'), 'utf8');

function segment(from, to) {
  const a = source.indexOf(from);
  assert.notEqual(a, -1, 'missing ' + from);
  const b = source.indexOf(to, a);
  assert.notEqual(b, -1, 'missing ' + to);
  return source.slice(a, b);
}

function fakeTransport() {
  const outputs = [];
  let seq = 0;
  const context = {
    dataChannels: {},
    sendClipBoardP2P: undefined,
    clearFiles: async () => {},
    enable_image_sharing: 'true',
    enable_file_sharing: 'true',
    validateClipboardSize: async () => true,
    NativeBridgeModule: {getFileAsBase64: async () => 'aW1hZ2U=', getFileName: async name => name},
    hashCB: async input => input,
    previous_clipboard_content_hash: '',
    p2pMsg: '',
    p2pStatusMessageChanged: async () => {},
    cipher_enabled: 'false',
    textEncoder: new TextEncoder(),
    encrypt: async x => x,
    fragmentString: async (text, max) => [text],
    FRAGMENT_SIZE: 15360,
    generateUuid: async () => 'fragment-' + (++seq),
    sendingFragmentId: '',
    sendingFragmentStats: null,
    resetSendingFragmentId: async function () { context.sendingFragmentId = ''; },
    sleep: async () => {},
    Date, Object, JSON, String,
  };
  context.newCB = async hcb => context.previous_clipboard_content_hash !== hcb;
  vm.createContext(context);
  vm.runInContext(
    segment('          const PENDING_CLIPBOARD_TTL_MS = 90000;', '\n          // Fragment variables') +
    '\n' + segment("          sendClipBoardP2P = async (clipContent, type_ = 'text', replay = false) => {", '\n          // stop events and connection P2P'),
    context
  );
  context.setOpenPeer = () => {
    const peer = {readyState: 'open', bufferedAmount: 0,
      send: async message => outputs.push(JSON.parse(message))};
    context.dataChannels.phone = peer;
    return peer;
  };
  context.getPending = () => vm.runInContext('pendingOutboundClipboard', context);
  context.flush = async () => vm.runInContext('flushPendingClipboard()', context);
  return {context, outputs};
}

test('Android copy during signaling-only connection is held and replayed when peer opens', async () => {
  const {context, outputs} = fakeTransport();
  await context.sendClipBoardP2P('copy-from-phone', 'text');
  assert.equal(context.previous_clipboard_content_hash, '');
  assert.equal(context.getPending().content, 'copy-from-phone');
  assert.equal(outputs.length, 0);
  context.setOpenPeer();
  await context.flush();
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].payload, 'copy-from-phone');
  assert.equal(context.getPending(), null);
  assert.equal(context.previous_clipboard_content_hash, 'copy-from-phone');
});

test('only newest offline copy survives, in RAM', async () => {
  const {context, outputs} = fakeTransport();
  await context.sendClipBoardP2P('earlier', 'text');
  await context.sendClipBoardP2P('newest', 'text');
  assert.equal(context.getPending().content, 'newest');
  context.setOpenPeer();
  await context.flush();
  assert.deepEqual(outputs.map(x => x.payload), ['newest']);
});

test('open channel sends once and ignores identical second copy', async () => {
  const {context, outputs} = fakeTransport();
  context.setOpenPeer();
  await context.sendClipBoardP2P('hello', 'text');
  await context.sendClipBoardP2P('hello', 'text');
  assert.equal(outputs.length, 1);
});

test('receipt of a remote image cannot consume the next genuine Android copy', async () => {
  const {context, outputs} = fakeTransport();
  assert.equal(source.includes('block_image_once'), false,
    'remote-image suppression must use native source label, not global next-copy flag');
  context.setOpenPeer();
  await context.sendClipBoardP2P('copy-after-remote-image', 'text');
  assert.equal(outputs.length, 1);
});

test('incoming fragments never cancel an unrelated outbound transfer', () => {
  const incoming = segment('          const onDataChannelMessage = async messageJson => {',
    '\n          /**\n           * The server gave us');
  assert.doesNotMatch(incoming, /resetSendingFragmentId\(\)/);
});

test('native listener ignores the exact received-image label and preserves user image copies', () => {
  const native = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ClipboardListenerModule.kt'), 'utf8');
  const bridge = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/NativeBridgeModule.kt'), 'utf8');
  const floating = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ClipboardFloatingActivity.kt'), 'utf8');
  assert.match(native, /CLIPCASCADE_REMOTE_IMAGE_LABEL/);
  assert.match(bridge, /ClipData\.newUri\([^\n]*CLIPCASCADE_REMOTE_IMAGE_LABEL/);
  assert.match(floating, /description\.label\?\.toString\(\) == CLIPCASCADE_REMOTE_IMAGE_LABEL/);
});

test('Android clipboard monitor has background logcat reader watchdog', () => {
  const native = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ClipboardListenerModule.kt'), 'utf8');
  assert.match(native, /logcatThread\?\.isAlive != true/);
  assert.match(native, /logcatWatchdogHandler\.postDelayed\(this, 60000L\)/);
});


test('Android screenshot URI is sent as an IMAGE and not a downloadable file', async () => {
  const {context, outputs} = fakeTransport();
  context.setOpenPeer();
  await context.sendClipBoardP2P('content://media/external/images/media/42', 'image');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, 'image');
  assert.equal(outputs[0].payload, 'aW1hZ2U=');
  assert.equal(context.previous_clipboard_content_hash, 'aW1hZ2U=');
});

test('multiple local images and a subsequent text copy remain independently sendable', async () => {
  const {context, outputs} = fakeTransport();
  context.setOpenPeer();
  await context.sendClipBoardP2P('content://example/image/1', 'image');
  await context.sendClipBoardP2P('my handwritten note after screenshot', 'text');
  assert.deepEqual(outputs.map(x => x.type), ['image', 'text']);
  assert.equal(outputs[1].payload, 'my handwritten note after screenshot');
});

test('native listeners preserve user-owned image URI events', () => {
  const native = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ClipboardListenerModule.kt'), 'utf8');
  const floating = fs.readFileSync(path.join(root,
    'ClipCascade_Mobile/src/android/app/src/main/java/com/clipcascade/ClipboardFloatingActivity.kt'), 'utf8');
  for (const code of [native, floating]) {
    assert.match(code, /description\.hasMimeType\("image\/\*"\) && item\.uri != null/);
    assert.match(code, /params\.putString\("type", "image"\)/);
    assert.match(code, /description\??\.label\?\.toString\(\) == CLIPCASCADE_REMOTE_IMAGE_LABEL/);
  }
});
