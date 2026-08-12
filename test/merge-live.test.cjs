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

// Theirs: a parallel agent added a farewell function and changed main.
const theirs = `def greet(name):
    return "Hello, " + name


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

async function liveTest() {
  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: '/tmp/example.py',
    model: process.env.LLM_SAVE_MERGE_MODEL || 'claude-sonnet-5',
    claudePath: process.env.LLM_SAVE_MERGE_CLAUDE || 'claude',
    timeoutMs: 120000,
  });
  console.log('--- merged ---');
  console.log(merged);
  console.log('--------------');
  assert.ok(merged.includes('f"Hello, {name}"'), 'kept OURS f-string edit');
  assert.ok(merged.includes('Return a greeting'), 'kept OURS docstring');
  assert.ok(merged.includes('def farewell'), 'kept THEIRS new function');
  assert.ok(merged.includes('print(farewell("world"))'), 'kept THEIRS main change');
  assert.ok(!/<\/?(base|ours|theirs|original_excerpt)>/.test(merged), 'no payload tag leakage');
  console.log('live full-file merge test passed');
}

// A larger file with localized edits goes through excerpt mode: the model sees only
// the changed span plus the two unified diffs, and returns the merged excerpt.
async function liveExcerptTest() {
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`Paragraph ${i} of the reference document.`);
  const bigBase = `${lines.join('\n')}\n`;
  const bigOurs = bigBase.replace(
    'Paragraph 20 of the reference document.',
    'Paragraph 20, rewritten in the editor and still unsaved.'
  );
  const bigTheirs = bigBase.replace(
    'Paragraph 27 of the reference document.',
    'Paragraph 27, rewritten on disk by a parallel session.'
  );
  const logged = [];
  const merged = await llmMerge({
    base: bigBase,
    ours: bigOurs,
    theirs: bigTheirs,
    filePath: '/tmp/document.md',
    model: process.env.LLM_SAVE_MERGE_MODEL || 'claude-sonnet-5',
    claudePath: process.env.LLM_SAVE_MERGE_CLAUDE || 'claude',
    timeoutMs: 120000,
    log: (message) => logged.push(message),
  });
  assert.ok(
    logged.some((m) => m.startsWith('excerpt merge:')),
    `excerpt mode engaged (log: ${logged.join(' | ')})`
  );
  assert.ok(
    !logged.some((m) => m.startsWith('excerpt merge failed')),
    `excerpt merge accepted (log: ${logged.join(' | ')})`
  );
  assert.ok(merged.includes('rewritten in the editor'), 'kept OURS edit');
  assert.ok(merged.includes('rewritten on disk'), 'kept THEIRS edit');
  const expected = bigOurs.replace(
    'Paragraph 27 of the reference document.',
    'Paragraph 27, rewritten on disk by a parallel session.'
  );
  assert.strictEqual(merged, expected, 'byte-identical to the mechanical expectation');
  console.log('live excerpt merge test passed');
}

async function main() {
  unitTests();
  await liveTest();
  await liveExcerptTest();
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
