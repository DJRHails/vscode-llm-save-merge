// Failure-path tests: what a failed claude call reports, how auth failures are
// classified, and how an env file reaches the child. Offline, stubbed CLI.
// Run: node test/failure.test.cjs
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { llmMerge, parseDotenv } = require('../merge.js');

// Unknown ancestor (base '') skips the excerpt plan, so every case is one full-file call.
const inputs = { base: '', ours: 'alpha!\nbeta\n', theirs: 'alpha\nbeta?\n', filePath: '/tmp/a.md' };

function writeStub(dir, body) {
  const stubPath = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the merge to reject');
}

function dotenvTests() {
  const parsed = parseDotenv(
    [
      '# comment line',
      '',
      'PLAIN=value',
      'export EXPORTED=exported value',
      'SPACED = padded ',
      'DOUBLE="quoted # not a comment"',
      "SINGLE='single quoted' # trailing comment",
      'BARE=bare # trailing comment',
      'HASH_INSIDE=a#b',
      'not a valid line',
      '1BAD=starts with digit',
      'EMPTY=',
    ].join('\n')
  );
  assert.deepStrictEqual(parsed, {
    PLAIN: 'value',
    EXPORTED: 'exported value',
    SPACED: 'padded',
    DOUBLE: 'quoted # not a comment',
    SINGLE: 'single quoted',
    BARE: 'bare',
    HASH_INSIDE: 'a#b',
    EMPTY: '',
  });
  console.log('dotenv tests passed');
}

async function stdoutAuthFailure(root) {
  const dir = fs.mkdtempSync(path.join(root, 'auth-'));
  // What claude 2.1.259 --print does with an expired login: message on stdout, exit 1.
  const stub = writeStub(
    dir,
    'cat > /dev/null\necho "Failed to authenticate: OAuth session expired and could not be refreshed"\nexit 1'
  );
  const logs = [];
  const err = await rejection(
    llmMerge({ ...inputs, model: 'stub', claudePath: stub, timeoutMs: 5000, log: (m) => logs.push(m) })
  );
  assert.match(err.message, /^claude exited 1: Failed to authenticate: OAuth session expired/);
  assert.strictEqual(err.auth, true, 'classified as an auth failure');
  assert.strictEqual(err.exitCode, 1);
  assert.match(err.stdout, /OAuth session expired/);
  assert.strictEqual(err.stderr, '');
  assert.match(err.authSources, /ANTHROPIC_API_KEY/);
  assert.match(err.authSources, /CLAUDE_CONFIG_DIR/);
  const spawnLine = logs.find((m) => m.startsWith('spawning '));
  assert.ok(spawnLine, 'the spawn is logged');
  assert.match(spawnLine, /--print --model stub/);
  console.log('stdout auth failure test passed');
}

async function stderrFailure(root) {
  const dir = fs.mkdtempSync(path.join(root, 'stderr-'));
  const stub = writeStub(dir, 'cat > /dev/null\necho "partial output" \necho "boom: disk on fire" >&2\nexit 2');
  const err = await rejection(llmMerge({ ...inputs, model: 'stub', claudePath: stub, timeoutMs: 5000 }));
  assert.strictEqual(err.message, 'claude exited 2: boom: disk on fire', 'stderr wins when present');
  assert.strictEqual(err.auth, false);
  assert.strictEqual(err.exitCode, 2);
  assert.strictEqual(err.stdout, 'partial output\n', 'stdout is kept for the log');
  console.log('stderr failure test passed');
}

async function silentFailure(root) {
  const dir = fs.mkdtempSync(path.join(root, 'silent-'));
  const stub = writeStub(dir, 'cat > /dev/null\nexit 1');
  const err = await rejection(llmMerge({ ...inputs, model: 'stub', claudePath: stub, timeoutMs: 5000 }));
  assert.strictEqual(err.message, 'claude exited 1: (no output on stdout or stderr)');
  assert.strictEqual(err.auth, false);
  console.log('silent failure test passed');
}

async function signalFailure(root) {
  const dir = fs.mkdtempSync(path.join(root, 'signal-'));
  const stub = writeStub(dir, 'cat > /dev/null\nkill -KILL $$');
  const err = await rejection(llmMerge({ ...inputs, model: 'stub', claudePath: stub, timeoutMs: 5000 }));
  assert.match(err.message, /^claude was killed by SIGKILL: \(no output/);
  assert.strictEqual(err.signal, 'SIGKILL');
  console.log('signal failure test passed');
}

async function extraEnvReachesChild(root) {
  const dir = fs.mkdtempSync(path.join(root, 'env-'));
  // The stub authenticates iff the key is present, and answers with a probe variable
  // so the test can tell the child saw the extra environment, not just the key.
  const stub = writeStub(
    dir,
    [
      'cat > /dev/null',
      'if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "Not logged in · Please run /login"; exit 1; fi',
      'printf "%s" "$LLM_SAVE_MERGE_PROBE"',
    ].join('\n')
  );
  const withoutKey = await rejection(
    llmMerge({ ...inputs, model: 'stub', claudePath: stub, timeoutMs: 5000, extraEnv: {} })
  );
  assert.strictEqual(withoutKey.auth, true, '"Not logged in" is an auth failure');
  assert.match(withoutKey.authSources, /^no ANTHROPIC_API_KEY/);

  const logs = [];
  const merged = await llmMerge({
    ...inputs,
    model: 'stub',
    claudePath: stub,
    timeoutMs: 5000,
    extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-secret-value', LLM_SAVE_MERGE_PROBE: 'alpha!\nbeta?\n' },
    log: (m) => logs.push(m),
  });
  assert.strictEqual(merged, 'alpha!\nbeta?\n', 'child saw the extra environment');
  const spawnLine = logs.find((m) => m.startsWith('spawning '));
  assert.match(spawnLine, /ANTHROPIC_API_KEY from envFile/);
  assert.ok(!logs.join('\n').includes('sk-ant-secret-value'), 'the key value never reaches the log');
  console.log('extra env test passed');
}

async function main() {
  dotenvTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-save-merge-failure-'));
  // The host environment must not decide these cases.
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await stdoutAuthFailure(root);
    await stderrFailure(root);
    await silentFailure(root);
    await signalFailure(root);
    await extraEnvReachesChild(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('all failure tests passed');
}

main().catch((err) => {
  console.error(`FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
