'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {classifySelectedIcePath} =
  require('../ClipCascade_Mobile/src/IcePathDiagnostics');

const report = candidateType => new Map([
  ['transport-id', {id: 'transport-id', type: 'transport',
    selectedCandidatePairId: 'pair-id'}],
  ['pair-id', {id: 'pair-id', type: 'candidate-pair', state: 'succeeded',
    localCandidateId: 'local-id', remoteCandidateId: 'remote-id'}],
  ['local-id', {id: 'local-id', type: 'local-candidate', candidateType,
    address: '192.0.2.11', port: 5454}],
  ['remote-id', {id: 'remote-id', type: 'remote-candidate',
    candidateType: 'host'}],
]);

test('selected local relay candidate proves TURN path independent of remote type', () => {
  assert.equal(classifySelectedIcePath(report('relay')), 'relay-selected');
});

test('selected local host/srflx candidates prove direct path, not relay', () => {
  for (const type of ['host', 'srflx', 'prflx'])
    assert.equal(classifySelectedIcePath(report(type)), 'direct-selected');
});

test('remote TURN relay is still a relayed path when local candidate is host', () => {
  const selected = report('host');
  selected.get('remote-id').candidateType = 'relay';
  assert.equal(classifySelectedIcePath(selected), 'relay-selected');
});

test('missing remote candidate prevents false claims of direct connectivity', () => {
  const selected = report('srflx');
  selected.delete('remote-id');
  assert.equal(classifySelectedIcePath(selected), 'unverified');
});

test('candidate list or TURN configured alone is not selected-path evidence', () => {
  assert.equal(classifySelectedIcePath(new Map([
    ['local-id', {id: 'local-id', type: 'local-candidate',
      candidateType: 'relay', ip: '203.0.113.11'}],
  ])), 'unverified');
  const noTransport = report('relay');
  noTransport.delete('transport-id');
  assert.equal(classifySelectedIcePath(noTransport), 'unverified');
});

test('explicitly selected candidate pair works, and ambiguous pairs stay unverified', () => {
  const stats = [...report('relay').values()].filter(x => x.type !== 'transport');
  stats[0].selected = true;
  assert.equal(classifySelectedIcePath(stats), 'relay-selected');
  stats.push({...stats[0], id: 'pair-2'});
  assert.equal(classifySelectedIcePath(stats), 'unverified');
});

test('does not surface candidate address, SDP or credentials', () => {
  const classified = classifySelectedIcePath(report('relay'));
  assert.equal(classified, 'relay-selected');
  assert.doesNotMatch(classified, /192\.0\.2\.11|candidate:/);
});
