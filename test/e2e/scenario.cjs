// Shared e2e scenarios: the launcher (run.cjs) bakes stub replies from these, and the
// in-host suite (suite.cjs) performs the same edits and waits for the same results.
// Each scenario owns one doc<N>.md so the payload-routed stub keeps them independent.
'use strict';

function numberedFile(prefix, n) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push(`${prefix} line ${i}`);
  return `${lines.join('\n')}\n`;
}

// Replace the full line numbered `lineNo` (1-indexed) in `text`.
function replaceLine(text, lineNo, newLine) {
  const lines = text.split('\n');
  lines[lineNo - 1] = newLine;
  return lines.join('\n');
}

// excerpt-merge (doc1): the basic path — dirty buffer + external write auto-merge.
const excerptMerge = {
  doc: 'doc1',
  base: numberedFile('doc1', 40),
  oursLine: [15, 'doc1 line 15, edited in the buffer and unsaved'],
  theirsLine: [25, 'doc1 line 25, rewritten on disk by another process'],
};

// full-file-fallback (doc2): the stub corrupts the excerpt reply, forcing the
// full-file prompt on the second call.
const fullFileFallback = {
  doc: 'doc2',
  base: numberedFile('doc2', 60),
  oursLine: [20, 'doc2 line 20, edited in the buffer and unsaved'],
  theirsLine: [40, 'doc2 line 40, rewritten on disk by another process'],
};

// reload-then-merge (doc3): an external write under a CLEAN buffer auto-reloads it
// (v1 -> v2); the merge that follows must use v2 as base, proving the extension
// re-based correctly on the reload (regression guard for the mid-transition
// change-event fix — a v1 base would change the excerpt span and fail the merge).
const reloadThenMerge = {
  doc: 'doc3',
  v1: numberedFile('doc3', 40),
  get v2() {
    return replaceLine(this.v1, 35, 'doc3 line 35, reloaded from disk while clean');
  },
  oursLine: [15, 'doc3 line 15, edited in the buffer after the reload'],
  theirsLine: [25, 'doc3 line 25, rewritten on disk after the reload'],
};

// mtime-only-touch (doc4): rewriting identical content must not merge or call the
// model at all.
const mtimeOnlyTouch = {
  doc: 'doc4',
  base: numberedFile('doc4', 40),
  oursLine: [15, 'doc4 line 15, edited in the buffer and unsaved'],
};

// manual-command (doc5): with auto-merge disabled, nothing fires on divergence; the
// palette command must still merge on demand.
const manualCommand = {
  doc: 'doc5',
  base: numberedFile('doc5', 40),
  oursLine: [15, 'doc5 line 15, edited in the buffer and unsaved'],
  theirsLine: [25, 'doc5 line 25, rewritten on disk by another process'],
};

// cancel-on-edit (doc6): a buffer edit while the model call is in flight must kill the
// call immediately and re-merge with the fresh buffer text. The stub's first call
// sleeps far longer than the assertion deadline, so only a genuine kill can pass.
const cancelOnEdit = {
  doc: 'doc6',
  base: numberedFile('doc6', 40),
  oursLine: [15, 'doc6 line 15, edited in the buffer and unsaved'],
  secondEdit: [5, 'doc6 line 5, edited again while the merge was in flight'],
  theirsLine: [25, 'doc6 line 25, rewritten on disk by another process'],
};

function ours(sc, base) {
  return replaceLine(base ?? sc.base, sc.oursLine[0], sc.oursLine[1]);
}

// Every merging scenario is a genuine dispute — disk rewrites the same line the buffer
// edited — plus a disk-only rewrite at `theirsLine` that the mechanical stage settles
// without the model. Disjoint edits would never reach the stub.
function theirsDisputed(sc) {
  return `${sc.doc} line ${sc.oursLine[0]}, rewritten on disk under the buffer's edit`;
}

function theirs(sc, base) {
  const disputed = replaceLine(base ?? sc.base, sc.oursLine[0], theirsDisputed(sc));
  return replaceLine(disputed, sc.theirsLine[0], sc.theirsLine[1]);
}

// The buffer wins the dispute; the disk-only rewrite lands.
function merged(sc, base) {
  return replaceLine(ours(sc, base), sc.theirsLine[0], sc.theirsLine[1]);
}

module.exports = {
  numberedFile,
  replaceLine,
  excerptMerge,
  fullFileFallback,
  reloadThenMerge,
  mtimeOnlyTouch,
  manualCommand,
  cancelOnEdit,
  ours,
  theirs,
  merged,
};
