// Launches a real VS Code (downloaded to .vscode-test/ on first run) with this
// extension loaded, and runs test/e2e/suite.cjs inside its extension host. The claude
// CLI is stubbed with a pre-baked merged excerpt, so the test is deterministic and
// offline. Headless: xvfb-run -a node test/e2e/run.cjs
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { buildExcerptPlan } = require('../../merge.js');
const scenario = require('./scenario.cjs');

function bakeStub(stubDir, workspace) {
  const plan = buildExcerptPlan({
    base: scenario.baseText(),
    ours: scenario.oursText(),
    theirs: scenario.theirsText(),
    filePath: path.join(workspace, 'doc.md'),
  });
  if (!plan) throw new Error('scenario unexpectedly has no excerpt plan');
  const mergedSegment = plan.baseSegment.map((line) => {
    if (line === 'line 15') return scenario.OURS_LINE;
    if (line === 'line 25') return scenario.THEIRS_LINE;
    return line;
  });
  fs.writeFileSync(path.join(stubDir, 'reply-0.txt'), `${mergedSegment.join('\n')}\n`);

  const stubPath = path.join(stubDir, 'claude-stub.sh');
  fs.writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'set -eu',
      'n=$(ls "$STUB_DIR" | grep -c "^call-" || true)',
      'cat > "$STUB_DIR/call-$n.txt"',
      'cat "$STUB_DIR/reply-$n.txt"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return stubPath;
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-save-merge-e2e-'));
  const workspace = path.join(root, 'workspace');
  const stubDir = path.join(root, 'stub');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(stubDir);
  fs.mkdirSync(home);

  fs.writeFileSync(path.join(workspace, 'doc.md'), scenario.baseText());
  const stubPath = bakeStub(stubDir, workspace);
  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'llmSaveMerge.claudePath': stubPath,
      'llmSaveMerge.timeoutMs': 30000,
      // Auto-save would save the dirty buffer mid-test; onDidSaveTextDocument then
      // re-bases the extension on the buffer text and the scenario evaporates.
      'files.autoSave': 'off',
    })
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
      extensionTestsEnv: {
        LSM_E2E_WORKSPACE: workspace,
        STUB_DIR: stubDir,
        HOME: home, // journals land under <home>/.local/state/llm-save-merge
      },
    });
    console.log('e2e test passed');
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.error(`artifacts kept for debugging at ${root}`);
    throw err;
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
