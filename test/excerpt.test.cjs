// Mechanical tests for excerpt-mode merging. The only "LLM" involved is a stub script,
// so this runs offline and fast. Run: node test/excerpt.test.cjs
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  llmMerge,
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
  const ours = withEdit(base, 15, 'line 15 ours');
  const theirs = withEdit(base, 25, 'line 25 theirs');
  const expected = withEdit(ours, 25, 'line 25 theirs');

  const plan = buildExcerptPlan({ base, ours, theirs, filePath: '/tmp/doc.md' });
  assert.ok(plan);
  const mergedSegment = plan.baseSegment
    .map((line) => {
      if (line === 'line 15') return 'line 15 ours';
      if (line === 'line 25') return 'line 25 theirs';
      return line;
    })
    .join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${mergedSegment}\n`);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/doc.md',
    model: 'stub',
    claudePath: makeStub(stubDir),
    timeoutMs: 10000,
  });
  assert.strictEqual(merged, expected, 'excerpt merge splices back to the full file');

  const payload = fs.readFileSync(path.join(stubDir, 'call-0.txt'), 'utf8');
  assert.ok(payload.includes(`Excerpt: lines ${plan.start}-${plan.end} of 40`));
  assert.ok(payload.includes('ORIGINAL EXCERPT'));
  assert.ok(payload.includes('DIFF, ORIGINAL TO OURS'));
  assert.ok(payload.includes('DIFF, ORIGINAL TO THEIRS'));
  assert.ok(!payload.includes('line 5\nline 6'), 'payload does not carry the whole file');
  const args = fs.readFileSync(path.join(stubDir, 'args-0.txt'), 'utf8');
  assert.ok(args.includes('merge on an excerpt'), 'excerpt instruction used');
  console.log('stubbed excerpt round-trip passed');
}

async function stubbedAnchorFallback(stubRoot) {
  const stubDir = fs.mkdtempSync(path.join(stubRoot, 'fallback-'));
  process.env.STUB_DIR = stubDir;
  const base = numberedFile(40);
  const ours = withEdit(base, 15, 'line 15 ours');
  const theirs = withEdit(base, 25, 'line 25 theirs');
  const plan = buildExcerptPlan({ base, ours, theirs, filePath: '/tmp/doc.md' });
  assert.ok(plan);

  // First reply corrupts an anchor line: excerpt mode must reject and fall back.
  const corrupted = ['CORRUPTED', ...plan.baseSegment.slice(1)].join('\n');
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${corrupted}\n`);
  const fullReply = withEdit(ours, 25, 'line 25 theirs');
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

async function main() {
  planTests();
  await fastPathTests();
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-save-merge-test-'));
  try {
    await stubbedRoundTrip(stubRoot);
    await stubbedAnchorFallback(stubRoot);
  } finally {
    fs.rmSync(stubRoot, { recursive: true, force: true });
  }
  console.log('all excerpt tests passed');
}

main().catch((err) => {
  console.error(`FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
