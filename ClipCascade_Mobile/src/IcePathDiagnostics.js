'use strict';

// Privacy-preserving selected ICE path classifier. Do not emit addresses,
// candidate SDP, usernames, credentials, raw RTCStats, or peer identities.
// Return 'unverified' unless the report identifies a *selected* candidate
// pair and its local candidate's type.
const classifySelectedIcePath = report => {
  const rows = [];
  if (report && typeof report.forEach === 'function') {
    report.forEach(item => rows.push(item));
  } else if (Array.isArray(report)) {
    rows.push(...report);
  } else if (report && typeof report === 'object') {
    rows.push(...Object.values(report));
  }
  const indexed = new Map(rows.filter(x => x && x.id).map(x => [x.id, x]));
  const transport = rows.find(x =>
    x && x.type === 'transport' && x.selectedCandidatePairId);
  let pair = transport && indexed.get(transport.selectedCandidatePairId);
  if (!pair) {
    const explicitlySelected = rows.filter(x =>
      x && x.type === 'candidate-pair' && x.selected === true &&
      x.state === 'succeeded');
    if (explicitlySelected.length !== 1) return 'unverified';
    pair = explicitlySelected[0];
  }
  if (!pair || pair.type !== 'candidate-pair') return 'unverified';
  const local = indexed.get(pair.localCandidateId);
  if (!local || local.type !== 'local-candidate') return 'unverified';
  if (local.candidateType === 'relay') return 'relay-selected';
  if (['host', 'srflx', 'prflx'].includes(local.candidateType))
    return 'direct-selected';
  return 'unverified';
};

module.exports = {classifySelectedIcePath};
