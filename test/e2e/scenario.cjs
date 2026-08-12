// Shared e2e scenario: the launcher (run.cjs) bakes the stub reply from it, and the
// in-host suite (suite.cjs) performs the same edits and waits for the same result.
'use strict';

const OURS_LINE = 'line 15, edited in the buffer and unsaved';
const THEIRS_LINE = 'line 25, rewritten on disk by another process';

function baseText() {
  const lines = [];
  for (let i = 1; i <= 40; i += 1) lines.push(`line ${i}`);
  return `${lines.join('\n')}\n`;
}

function oursText() {
  return baseText().replace('line 15', OURS_LINE);
}

function theirsText() {
  return baseText().replace('line 25', THEIRS_LINE);
}

function expectedMerged() {
  return oursText().replace('line 25', THEIRS_LINE);
}

module.exports = { OURS_LINE, THEIRS_LINE, baseText, oursText, theirsText, expectedMerged };
