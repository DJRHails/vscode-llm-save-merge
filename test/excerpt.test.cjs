// Mechanical tests for excerpt-mode merging. The only "LLM" involved is a stub script,
// so this runs offline and fast. Run: node test/excerpt.test.cjs
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  llmMerge,
  mechanicalMerge,
  buildExcerptPlan,
  splitLines,
  joinLines,
  spliceSegment,
} = require('../merge.js');

function numberedFile(n) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push(`line ${i}`);
  return `${lines.join('\n')}\n`;
}

// Replace 1-indexed line `lineNo` with `replacement` (null deletes, array inserts after).
function withEdit(text, lineNo, replacement) {
  const { lines, trailingNewline } = splitLines(text);
  if (replacement === null) lines.splice(lineNo - 1, 1);
  else if (Array.isArray(replacement)) lines.splice(lineNo, 0, ...replacement);
  else lines[lineNo - 1] = replacement;
  return joinLines(lines, trailingNewline);
}

function planTests() {
  const base = numberedFile(60);
  const ours = withEdit(base, 20, 'line 20 ours');
  const theirs = withEdit(base, 30, 'line 30 theirs');
  const plan = buildExcerptPlan({ base, ours, theirs, filePath: '/tmp/a.txt' });
  assert.ok(plan, 'localized edits produce a plan');
  assert.strictEqual(plan.start, 14, 'span start: hunk context 17 minus pad 3');
  assert.strictEqual(plan.end, 36, 'span end: hunk context 33 plus pad 3');
  assert.strictEqual(plan.leadAnchor, 3);
  assert.strictEqual(plan.trailAnchor, 3);
  assert.strictEqual(plan.baseSegment.length, 23);
  assert.ok(plan.oursDiff.includes('line 20 ours'));
  assert.ok(plan.theirsDiff.includes('line 30 theirs'));

  // Insertions and deletions shift the segment ends without breaking the invariant.
  const oursIns = withEdit(base, 20, ['inserted a', 'inserted b']);
  const theirsDel = withEdit(base, 30, null);
  const asymmetric = buildExcerptPlan({
    base,
    ours: oursIns,
    theirs: theirsDel,
    filePath: '/tmp/a.txt',
  });
  assert.ok(asymmetric, 'insertion vs deletion still plans');
  assert.strictEqual(asymmetric.oursSegment.length, asymmetric.baseSegment.length + 2);
  assert.strictEqual(asymmetric.theirsSegment.length, asymmetric.baseSegment.length - 1);
  const rebuilt = joinLines(
    spliceSegment(
      splitLines(base).lines,
      asymmetric.start,
      asymmetric.end,
      asymmetric.oursSegment
    ),
    true
  );
  assert.strictEqual(rebuilt, oursIns, 'splice invariant reproduces ours');

  // Edits at both ends of a small file cover too much: fall back to full-file mode.
  const tiny = numberedFile(10);
  const wide = buildExcerptPlan({
    base: tiny,
    ours: withEdit(tiny, 1, 'line 1 ours'),
    theirs: withEdit(tiny, 10, 'line 10 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.strictEqual(wide, null, 'span above ratio cap yields no plan');

  assert.strictEqual(
    buildExcerptPlan({ base: '', ours: 'a\n', theirs: 'b\n', filePath: '/tmp/a.txt' }),
    null,
    'unknown ancestor yields no plan'
  );

  // Edits at the very first line clamp the span at the file start (no lead anchor).
  const bof = buildExcerptPlan({
    base,
    ours: withEdit(base, 1, 'line 1 ours'),
    theirs: withEdit(base, 3, 'line 3 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.ok(bof, 'edits at file start still plan');
  assert.strictEqual(bof.start, 1);
  assert.strictEqual(bof.leadAnchor, 0);

  // No trailing newline round-trips through the invariant.
  const bare = numberedFile(40).trimEnd();
  const bareplan = buildExcerptPlan({
    base: bare,
    ours: withEdit(bare, 15, 'line 15 ours'),
    theirs: withEdit(bare, 25, 'line 25 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.ok(bareplan, 'file without trailing newline still plans');

  // Excerpt edges move onto non-blank lines: models trim blank lines from the ends of
  // their output, and a blank edge anchor would be refused on every reply.
  const blankEdges = withEdit(withEdit(base, 9, ''), 21, '');
  const blankPlan = buildExcerptPlan({
    base: blankEdges,
    ours: withEdit(blankEdges, 15, 'line 15 ours'),
    theirs: withEdit(blankEdges, 15, 'line 15 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.strictEqual(blankPlan.start, 8, 'start extends past the blank line 9');
  assert.strictEqual(blankPlan.end, 22, 'end extends past the blank line 21');
  assert.strictEqual(blankPlan.leadAnchor, 4);
  assert.strictEqual(blankPlan.trailAnchor, 4);

  // At a blank file edge the pad shrinks inward instead, leaving no anchor there.
  const blankTail = withEdit(withEdit(base, 59, ''), 60, '');
  const tailPlan = buildExcerptPlan({
    base: blankTail,
    ours: withEdit(blankTail, 55, 'line 55 ours'),
    theirs: withEdit(blankTail, 55, 'line 55 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.strictEqual(tailPlan.end, 58, 'end shrinks onto the last non-blank line');
  assert.strictEqual(tailPlan.trailAnchor, 0);
  const blankHead = withEdit(withEdit(base, 1, ''), 2, '');
  const headPlan = buildExcerptPlan({
    base: blankHead,
    ours: withEdit(blankHead, 6, 'line 6 ours'),
    theirs: withEdit(blankHead, 6, 'line 6 theirs'),
    filePath: '/tmp/a.txt',
  });
  assert.strictEqual(headPlan.start, 3, 'start shrinks onto the first non-blank line');
  assert.strictEqual(headPlan.leadAnchor, 0);

  console.log('plan tests passed');
}

async function fastPathTests() {
  const base = numberedFile(5);
  const changed = withEdit(base, 2, 'line 2 changed');
  const opts = { filePath: '/tmp/a.txt', model: 'stub', claudePath: '/nonexistent', timeoutMs: 50 };
  assert.strictEqual(await llmMerge({ ...opts, base, ours: base, theirs: changed }), changed);
  assert.strictEqual(await llmMerge({ ...opts, base, ours: changed, theirs: base }), changed);
  console.log('fast-path tests passed (no model spawned)');
}

// Edits the two sides do not dispute merge without a model; a spawn attempt against a
// nonexistent binary is how a test tells that the model was (wrongly, or rightly) asked.
async function mechanicalTests() {
  const base = numberedFile(40);
  const opts = { filePath: '/tmp/a.txt', model: 'stub', claudePath: '/nonexistent', timeoutMs: 50 };
  const logs = [];
  const merge = (ours, theirs) =>
    llmMerge({ ...opts, base, ours, theirs, log: (m) => logs.push(m) });
  const disputed = (ours, theirs, label) =>
    assert.rejects(merge(ours, theirs), /failed to spawn/, `${label}: must go to the model`);

  const ours15 = withEdit(base, 15, 'line 15 ours');
  const theirs25 = withEdit(base, 25, 'line 25 theirs');
  assert.strictEqual(
    await merge(ours15, theirs25),
    withEdit(ours15, 25, 'line 25 theirs'),
    'disjoint rewrites both land'
  );
  assert.ok(
    logs.includes('merged mechanically: 2 hunks, none disputed; no model call'),
    `mechanical merge logged (${logs.join(' | ')})`
  );

  const inserted = withEdit(base, 10, ['inserted a', 'inserted b']);
  const deleted = withEdit(base, 30, null);
  assert.strictEqual(
    await merge(inserted, deleted),
    withEdit(inserted, 32, null),
    'an insertion and a deletion far apart'
  );
  const topInsert = withEdit(base, 0, ['top']);
  assert.strictEqual(
    await merge(topInsert, `${base}appended\n`),
    `top\n${base}appended\n`,
    'an insertion at the top and a line appended at the end'
  );

  // Base line 20 is untouched between an insertion after it and a rewrite of line 19.
  const afterTwenty = withEdit(base, 20, ['after twenty']);
  assert.strictEqual(
    await merge(afterTwenty, withEdit(base, 19, 'line 19 theirs')),
    withEdit(afterTwenty, 19, 'line 19 theirs'),
    'an unchanged line between the edits keeps them independent'
  );

  const same = withEdit(base, 15, 'line 15 both');
  assert.strictEqual(await merge(same, same), same, 'identical edits apply once');
  assert.strictEqual(
    await merge(same, withEdit(same, 30, 'line 30 theirs')),
    withEdit(same, 30, 'line 30 theirs'),
    'an identical edit beside a disk-only one'
  );

  // The trailing newline is merged three-way on its own.
  const oursThree = withEdit(base, 3, 'line 3 ours');
  assert.strictEqual(
    await merge(oursThree, base.slice(0, -1)),
    oursThree.slice(0, -1),
    'disk dropping the trailing newline merges with a buffer line edit'
  );
  const theirsTwo = withEdit(base, 2, 'line 2 theirs');
  assert.strictEqual(
    await merge(`${base}\n`, theirsTwo),
    `${theirsTwo}\n`,
    'a blank line added at EOF merges with a disk line edit'
  );

  await disputed(ours15, withEdit(base, 15, 'line 15 theirs'), 'same line rewritten both ways');
  const ours20 = withEdit(base, 20, 'line 20 ours');
  await disputed(ours20, withEdit(base, 21, 'line 21 theirs'), 'adjacent rewrites');
  const theirs20 = withEdit(base, 20, 'line 20 theirs');
  await disputed(afterTwenty, theirs20, 'insertion right after a rewritten line');
  await disputed(afterTwenty, withEdit(base, 20, ['theirs after 20']), 'insertions at one spot');
  await disputed(ours20, withEdit(base, 20, null), 'rewrite against deletion');
  console.log('mechanical tests passed (no model spawned)');
}

// git merge-file is the reference for which edit pairs are disputed and for what a clean
// merge produces. Seeded, so a failure reproduces.
function gitOracleTest(stubRoot) {
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.log('git oracle test skipped (no git on PATH)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(stubRoot, 'oracle-'));
  let seed = 20260903;
  const rand = (n) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const randomEdits = (text, tag) => {
    const { lines } = splitLines(text);
    for (let k = 0, edits = 1 + rand(3); k < edits; k += 1) {
      const at = rand(lines.length);
      const kind = rand(3);
      if (kind === 0) lines[at] = `${tag} rewrote ${k}`;
      else if (kind === 1) lines.splice(at, 0, `${tag} inserted ${k}`);
      else if (lines.length > 3) lines.splice(at, 1);
    }
    return joinLines(lines, true);
  };
  const base = numberedFile(12);
  const files = ['ours', 'base', 'theirs'].map((name) => path.join(dir, name));
  let clean = 0;
  for (let i = 0; i < 300; i += 1) {
    const ours = randomEdits(base, 'ours');
    const theirs = randomEdits(base, 'theirs');
    if (ours === base || theirs === base) continue;
    const outcome = mechanicalMerge({ base, ours, theirs });
    assert.ok(outcome, `hunk arithmetic holds (case ${i})`);
    [ours, base, theirs].forEach((text, j) => fs.writeFileSync(files[j], text));
    const git = spawnSync('git', ['merge-file', '-p', ...files], { encoding: 'utf8' });
    const label = `case ${i}\n<ours>\n${ours}<theirs>\n${theirs}`;
    if (outcome.disputed === 0) {
      assert.strictEqual(git.status, 0, `git also merges cleanly: ${label}`);
      assert.strictEqual(outcome.merged, git.stdout, `same text as git: ${label}`);
      clean += 1;
    } else {
      assert.notStrictEqual(git.status, 0, `git also reports a conflict: ${label}`);
    }
  }
  assert.ok(clean > 50, `enough clean cases exercised (${clean})`);
  console.log(`git oracle test passed (${clean} clean merges identical to git merge-file)`);
}

// A genuine dispute: both sides rewrite line 15, and disk also rewrites line 25. The
// mechanical stage settles line 25 on its own and hands the model a plan spanning only
// the disputed line, where the buffer wins.
function disputedEdits(base) {
  const ours = withEdit(base, 15, 'line 15 ours');
  const theirs = withEdit(withEdit(base, 15, 'line 15 theirs'), 25, 'line 25 theirs');
  const expected = withEdit(ours, 25, 'line 25 theirs');
  return { ours, theirs, expected };
}

// The excerpt plan the model actually sees: computed after the mechanical stage.
function modelPlan(base, ours, theirs) {
  const staged = mechanicalMerge({ base, ours, theirs });
  assert.ok(staged && staged.disputed > 0, 'fixture must leave something disputed');
  return buildExcerptPlan({ ...staged, filePath: '/tmp/doc.md' });
}

function makeStub(stubDir) {
  const stubPath = path.join(stubDir, 'claude-stub.sh');
  fs.writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'set -eu',
      'n=$(ls "$STUB_DIR" | grep -c "^call-" || true)',
      'printf \'%s\\n\' "$@" > "$STUB_DIR/args-$n.txt"',
      'cat > "$STUB_DIR/call-$n.txt"',
      'cat "$STUB_DIR/reply-$n.txt"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return stubPath;
}

async function stubbedRoundTrip(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'roundtrip-'));
  process.env.STUB_DIR = stubDir;
  const base = numberedFile(40);
  const { ours, theirs, expected } = disputedEdits(base);

  const plan = modelPlan(base, ours, theirs);
  assert.ok(plan);
  const mergedSegment = plan.baseSegment
    .map((line) => (line === 'line 15' ? 'line 15 ours' : line))
    .join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${mergedSegment}\n`);

  const logs = [];
  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/doc.md',
    model: 'stub',
    claudePath: makeStub(stubDir),
    timeoutMs: 10000,
    log: (m) => logs.push(m),
  });
  assert.strictEqual(merged, expected, 'excerpt merge splices back to the full file');
  assert.ok(
    logs.includes('mechanical stage settled 1 hunks; 2 disputed hunks go to the model'),
    `mechanical stage logged (${logs.join(' | ')})`
  );

  const payload = fs.readFileSync(path.join(stubDir, 'call-0.txt'), 'utf8');
  assert.ok(payload.includes(`<excerpt_range>lines ${plan.start}-${plan.end} of 40</excerpt_range>`));
  assert.ok(plan.end - plan.start < 15, `plan spans only the dispute (${plan.start}-${plan.end})`);
  assert.ok(payload.includes('<original_excerpt>'), 'excerpt wrapped in XML tags');
  assert.ok(payload.includes('<diff_original_to_ours>'));
  assert.ok(payload.includes('<diff_original_to_theirs>'));
  assert.ok(!payload.includes('line 5\nline 6'), 'payload does not carry the whole file');
  assert.ok(!payload.includes('line 25'), 'the settled disk-only hunk never reaches the model');
  const args = fs.readFileSync(path.join(stubDir, 'args-0.txt'), 'utf8');
  assert.ok(args.includes('merge on an excerpt'), 'excerpt instruction used');
  console.log('stubbed excerpt round-trip passed');
}

// Models trim blank lines from the ends of their output. With the plan's edges on
// non-blank lines, such a reply passes the anchor check — no full-file fallback.
async function stubbedTrimmedReply(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'trimmed-'));
  process.env.STUB_DIR = stubDir;
  const base = withEdit(withEdit(numberedFile(40), 9, ''), 21, '');
  const { ours, theirs, expected } = disputedEdits(base);
  const plan = modelPlan(base, ours, theirs);
  const reply = plan.baseSegment
    .map((line) => (line === 'line 15' ? 'line 15 ours' : line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${reply}\n`);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/doc.md',
    model: 'stub',
    claudePath: makeStub(stubDir),
    timeoutMs: 10000,
  });
  assert.strictEqual(merged, expected, 'edge-trimmed reply accepted');
  const calls = fs.readdirSync(stubDir).filter((f) => f.startsWith('call-'));
  assert.strictEqual(calls.length, 1, 'no full-file fallback call');
  console.log('trimmed-reply test passed');
}

async function stubbedAnchorFallback(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'fallback-'));
  process.env.STUB_DIR = stubDir;
  const base = numberedFile(40);
  const { ours, theirs, expected } = disputedEdits(base);
  const plan = modelPlan(base, ours, theirs);
  assert.ok(plan);

  // First reply corrupts an anchor line: excerpt mode must reject and fall back.
  const corrupted = ['CORRUPTED', ...plan.baseSegment.slice(1)].join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${corrupted}\n`);
  const fullReply = expected;
  fs.writeFileSync(path.join(stubDir, 'reply-1.txt'), fullReply);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/doc.md',
    model: 'stub',
    claudePath: makeStub(stubDir),
    timeoutMs: 10000,
  });
  assert.strictEqual(merged, fullReply, 'fallback returned the full-file merge');
  const secondArgs = fs.readFileSync(path.join(stubDir, 'args-1.txt'), 'utf8');
  assert.ok(secondArgs.includes('three-way merge of a text file'), 'full-file instruction used');
  console.log('anchor-violation fallback passed');
}

async function stubbedTagLeakFallback(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'tagleak-'));
  process.env.STUB_DIR = stubDir;
  const base = numberedFile(40);
  const { ours, theirs, expected } = disputedEdits(base);
  const plan = modelPlan(base, ours, theirs);
  assert.ok(plan);

  // First reply echoes payload structure: the leak check must reject it.
  const leaky = ['<original_excerpt>', ...plan.baseSegment, '</original_excerpt>'].join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${leaky}\n`);
  const fullReply = expected;
  fs.writeFileSync(path.join(stubDir, 'reply-1.txt'), fullReply);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/doc.md',
    model: 'stub',
    claudePath: makeStub(stubDir),
    timeoutMs: 10000,
  });
  assert.strictEqual(merged, fullReply, 'tag leak rejected, full-file fallback returned');
  console.log('tag-leak fallback passed');
}

async function stubbedStaleAbort(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'stale-'));
  process.env.STUB_DIR = stubDir;
  const base = numberedFile(40);
  const { ours, theirs } = disputedEdits(base);
  const plan = modelPlan(base, ours, theirs);
  assert.ok(plan);
  // The excerpt reply is rejected (broken anchor); with stale inputs the full-file
  // retry must be skipped and the stale marker surfaced instead.
  const corrupted = ['CORRUPTED', ...plan.baseSegment.slice(1)].join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${corrupted}\n`);

  await assert.rejects(
    llmMerge({
      base,
      ours,
      theirs,
      filePath: '/tmp/doc.md',
      model: 'stub',
      claudePath: makeStub(stubDir),
      timeoutMs: 10000,
      isStale: async () => true,
    }),
    (err) => err.stale === true,
    'stale inputs abort with the stale marker'
  );
  const calls = fs.readdirSync(stubDir).filter((f) => f.startsWith('call-'));
  assert.strictEqual(calls.length, 1, 'no second model call on stale inputs');
  console.log('stale-abort test passed');
}

function fakeCancellation() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.push(listener);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) listener();
    },
  };
}

async function cancellationTest(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'cancel-'));
  process.env.STUB_DIR = stubDir;
  const hangPath = path.join(stubDir, 'claude-hang.sh');
  fs.writeFileSync(hangPath, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });

  const base = numberedFile(40);
  const cancellation = fakeCancellation();
  setTimeout(() => cancellation.cancel(), 200);
  const started = Date.now();
  await assert.rejects(
    llmMerge({
      base,
      ours: withEdit(base, 15, 'line 15 ours'),
      theirs: withEdit(base, 15, 'line 15 theirs'),
      filePath: '/tmp/doc.md',
      model: 'stub',
      claudePath: hangPath,
      timeoutMs: 20000,
      cancellation,
    }),
    (err) => err.cancelled === true && /cancelled/.test(err.message),
    'cancel rejects with the cancelled marker'
  );
  assert.ok(Date.now() - started < 5000, 'cancel kills the child promptly, no fallback call');
  console.log('cancellation test passed');
}

async function main() {
  planTests();
  await fastPathTests();
  await mechanicalTests();
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-save-merge-test-'));
  try {
    gitOracleTest(stubRoot);
    await stubbedRoundTrip(stubRoot);
    await stubbedTrimmedReply(stubRoot);
    await stubbedAnchorFallback(stubRoot);
    await stubbedTagLeakFallback(stubRoot);
    await stubbedStaleAbort(stubRoot);
    await cancellationTest(stubRoot);
  } finally {
    fs.rmSync(stubRoot, { recursive: true, force: true });
  }
  console.log('all excerpt tests passed');
}

main().catch((err) => {
  console.error(`FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
