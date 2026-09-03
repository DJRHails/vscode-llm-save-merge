// Live integration test: exercises the real claude CLI through llmMerge.
// Run: node test/merge-live.test.cjs
'use strict';

const assert = require('node:assert');
const { llmMerge, normalizeTrailingNewline, stripWrappingFence } = require('../merge.js');

const base = `def greet(name):
    return "Hello, " + name


def main():
    print(greet("world"))
`;

// Ours: the user's unsaved edit — f-string + docstring.
const ours = `def greet(name):
    """Return a greeting for name."""
    return f"Hello, {name}"


def main():
    print(greet("world"))
`;

// Theirs: a parallel agent punctuated the greeting (disputing the line ours rewrote),
// added a farewell function, and changed main.
const theirs = `def greet(name):
    return "Hello, " + name + "!"


def farewell(name):
    return "Goodbye, " + name


def main():
    print(greet("world"))
    print(farewell("world"))
`;

function unitTests() {
  assert.strictEqual(stripWrappingFence('```py\nx = 1\n```'), 'x = 1\n');
  assert.strictEqual(stripWrappingFence('x = 1\n'), 'x = 1\n');
  assert.strictEqual(normalizeTrailingNewline('a', 'x\n', 'y\n'), 'a\n');
  assert.strictEqual(normalizeTrailingNewline('a\n', 'x', 'y'), 'a');
  console.log('unit checks passed');
}

const liveOpts = {
  model: process.env.LLM_SAVE_MERGE_MODEL || 'claude-sonnet-5',
  claudePath: process.env.LLM_SAVE_MERGE_CLAUDE || 'claude',
  timeoutMs: 120000,
};

async function liveTest() {
  const logged = [];
  const merged = await llmMerge({
    ...liveOpts,
    base,
    ours,
    theirs,
    filePath: '/tmp/example.py',
    log: (message) => logged.push(message),
  });
  console.log('--- merged ---');
  console.log(merged);
  console.log('--------------');
  assert.ok(
    logged.some((m) => m.startsWith('mechanical stage settled')),
    `undisputed hunks settled before the model call (log: ${logged.join(' | ')})`
  );
  assert.ok(merged.includes('f"Hello, {name}"'), 'kept OURS f-string edit');
  assert.ok(merged.includes('Return a greeting'), 'kept OURS docstring');
  assert.ok(merged.includes('def farewell'), 'kept THEIRS new function');
  assert.ok(merged.includes('print(farewell("world"))'), 'kept THEIRS main change');
  assert.ok(!/<\/?(base|ours|theirs|original_excerpt)>/.test(merged), 'no payload tag leakage');
  console.log('live full-file merge test passed');
}

function paragraphs(n) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push(`Paragraph ${i} of the reference document.`);
  return `${lines.join('\n')}\n`;
}

function rewrite(text, paragraph, replacement) {
  return text.replace(`Paragraph ${paragraph} of the reference document.`, replacement);
}

// Edits to different paragraphs never reach the model: the mechanical stage merges them.
async function liveMechanicalTest() {
  const bigBase = paragraphs(60);
  const bigOurs = rewrite(bigBase, 20, 'Paragraph 20, rewritten in the editor and still unsaved.');
  const bigTheirs = rewrite(bigBase, 27, 'Paragraph 27, rewritten on disk by a parallel session.');
  const logged = [];
  const merged = await llmMerge({
    ...liveOpts,
    base: bigBase,
    ours: bigOurs,
    theirs: bigTheirs,
    filePath: '/tmp/document.md',
    log: (message) => logged.push(message),
  });
  assert.ok(
    logged.some((m) => m.startsWith('merged mechanically:')),
    `mechanical merge (log: ${logged.join(' | ')})`
  );
  assert.ok(!logged.some((m) => m.startsWith('spawning')), 'no model call');
  const expected = rewrite(bigOurs, 27, 'Paragraph 27, rewritten on disk by a parallel session.');
  assert.strictEqual(merged, expected, 'byte-identical to the expected merge');
  console.log('live mechanical merge test passed (no model call)');
}

// A disputed paragraph beside a disk-only one goes through excerpt mode: the model sees
// only the disputed span plus the two unified diffs, and returns the merged excerpt.
async function liveExcerptTest() {
  const bigBase = paragraphs(60);
  const bigOurs = rewrite(bigBase, 20, 'Paragraph 20, rewritten in the editor and still unsaved.');
  const bigTheirs = rewrite(
    rewrite(bigBase, 20, 'Paragraph 20, rewritten on disk under the editor edit.'),
    40,
    'Paragraph 40, rewritten on disk by a parallel session.'
  );
  const logged = [];
  const merged = await llmMerge({
    ...liveOpts,
    base: bigBase,
    ours: bigOurs,
    theirs: bigTheirs,
    filePath: '/tmp/document.md',
    log: (message) => logged.push(message),
  });
  const span = logged.find((m) => m.startsWith('excerpt merge:'));
  assert.ok(span, `excerpt mode engaged (log: ${logged.join(' | ')})`);
  const [, start, end] = span.match(/lines (\d+)-(\d+)/);
  assert.ok(Number(end) - Number(start) < 15, `excerpt spans only the dispute (${span})`);
  assert.ok(
    !logged.some((m) => m.startsWith('excerpt merge failed')),
    `excerpt merge accepted (log: ${logged.join(' | ')})`
  );
  assert.ok(merged.includes('rewritten in the editor'), 'kept OURS side of the dispute');
  assert.ok(merged.includes('Paragraph 40, rewritten on disk'), 'kept THEIRS disk-only edit');
  const expected = rewrite(bigOurs, 40, 'Paragraph 40, rewritten on disk by a parallel session.');
  assert.strictEqual(merged, expected, 'byte-identical to the expected merge');
  console.log('live excerpt merge test passed');
}

async function main() {
  unitTests();
  await liveMechanicalTest();
  await liveTest();
  await liveExcerptTest();
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
