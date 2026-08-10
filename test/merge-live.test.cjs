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
  assert.ok(!merged.includes('LLM-SAVE-MERGE'), 'no sentinel leakage');
  console.log('live merge test passed');
}

unitTests();
liveTest().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
