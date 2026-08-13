// Launches a real VS Code (downloaded to .vscode-test/ on first run) with this
// extension loaded, and runs test/e2e/suite.cjs inside its extension host. The claude
// CLI is stubbed — replies are routed by the <file_path> in the payload, numbered per
// doc — so the test is deterministic and offline. Headless: xvfb-run -a npm run test:e2e
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { buildExcerptPlan } = require('../../merge.js');
const scenario = require('./scenario.cjs');

// The stub extracts docN from the payload's <file_path> and answers with the next
// reply-docN-<i>.txt, capturing payload and args alongside for suite assertions.
const STUB_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'payload=$(cat)',
  'doc=$(printf \'%s\' "$payload" | sed -n \'s|.*<file_path>.*/\\(doc[0-9]*\\)\\.md</file_path>.*|\\1|p\' | head -1)',
  'n=$(ls "$STUB_DIR" | grep -c "^call-$doc-" || true)',
  'printf \'%s\' "$payload" > "$STUB_DIR/call-$doc-$n.txt"',
  'printf \'%s\\n\' "$@" > "$STUB_DIR/args-$doc-$n.txt"',
  // A slow-<doc>-<n> marker makes that call hang (killable: the sleep runs detached
  // in the background so SIGTERM to the shell releases the stdio pipes immediately).
  'if [ -e "$STUB_DIR/slow-$doc-$n" ]; then',
  '  sleep 20 </dev/null >/dev/null 2>&1 &',
  '  wait $!',
  'fi',
  'cat "$STUB_DIR/reply-$doc-$n.txt"',
  '',
].join('\n');

function excerptReply({ base, ours, theirs, docPath }) {
  const plan = buildExcerptPlan({ base, ours, theirs, filePath: docPath });
  if (!plan) throw new Error(`scenario for ${docPath} unexpectedly has no excerpt plan`);
  // These scenarios only replace whole lines (no inserts/deletes), so positions align
  // across all three versions: take whichever side changed each segment line.
  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');
  const mergedSegment = plan.baseSegment.map((line, i) => {
    const at = plan.start - 1 + i;
    if (oursLines[at] !== line) return oursLines[at];
    if (theirsLines[at] !== line) return theirsLines[at];
    return line;
  });
  return `${mergedSegment.join('\n')}\n`;
}

function bakeReplies(stubDir, workspace) {
  const docPath = (doc) => path.join(workspace, `${doc}.md`);
  const write = (name, content) => fs.writeFileSync(path.join(stubDir, name), content);

  // excerpt-merge: one clean excerpt reply.
  {
    const sc = scenario.excerptMerge;
    write(
      `reply-${sc.doc}-0.txt`,
      excerptReply({
        base: sc.base,
        ours: scenario.ours(sc),
        theirs: scenario.theirs(sc),
        docPath: docPath(sc.doc),
      })
    );
  }

  // full-file-fallback: first reply corrupts a leading anchor line, second reply is
  // the valid full merged file.
  {
    const sc = scenario.fullFileFallback;
    const good = excerptReply({
      base: sc.base,
      ours: scenario.ours(sc),
      theirs: scenario.theirs(sc),
      docPath: docPath(sc.doc),
    });
    const corrupted = ['CORRUPTED ANCHOR', ...good.split('\n').slice(1)].join('\n');
    write(`reply-${sc.doc}-0.txt`, corrupted);
    write(`reply-${sc.doc}-1.txt`, scenario.merged(sc));
  }

  // reload-then-merge: the merge happens against v2 (the auto-reloaded content). If
  // the extension's base were still v1, its excerpt span would differ from this
  // reply's span and validation would reject the merge — which is the point.
  {
    const sc = scenario.reloadThenMerge;
    write(
      `reply-${sc.doc}-0.txt`,
      excerptReply({
        base: sc.v2,
        ours: scenario.ours(sc, sc.v2),
        theirs: scenario.theirs(sc, sc.v2),
        docPath: docPath(sc.doc),
      })
    );
  }

  // mtime-only-touch: no reply — any call is a failure the suite asserts on.

  // cancel-on-edit: the first call hangs (slow marker) and gets killed by the
  // mid-call buffer edit; the second call merges the fresh buffer against disk.
  {
    const sc = scenario.cancelOnEdit;
    fs.writeFileSync(path.join(stubDir, `slow-${sc.doc}-0`), '');
    write(`reply-${sc.doc}-0.txt`, 'unused: this call is expected to be killed\n');
    const oursTwice = scenario.replaceLine(
      scenario.ours(sc),
      sc.secondEdit[0],
      sc.secondEdit[1]
    );
    write(
      `reply-${sc.doc}-1.txt`,
      excerptReply({
        base: sc.base,
        ours: oursTwice,
        theirs: scenario.theirs(sc),
        docPath: docPath(sc.doc),
      })
    );
  }

  // manual-command: one clean excerpt reply, reached only via the palette command.
  {
    const sc = scenario.manualCommand;
    write(
      `reply-${sc.doc}-0.txt`,
      excerptReply({
        base: sc.base,
        ours: scenario.ours(sc),
        theirs: scenario.theirs(sc),
        docPath: docPath(sc.doc),
      })
    );
  }
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

  for (const sc of [
    scenario.excerptMerge,
    scenario.fullFileFallback,
    scenario.mtimeOnlyTouch,
    scenario.manualCommand,
    scenario.cancelOnEdit,
  ]) {
    fs.writeFileSync(path.join(workspace, `${sc.doc}.md`), sc.base);
  }
  fs.writeFileSync(
    path.join(workspace, `${scenario.reloadThenMerge.doc}.md`),
    scenario.reloadThenMerge.v1
  );

  bakeReplies(stubDir, workspace);
  const stubPath = path.join(stubDir, 'claude-stub.sh');
  fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });

  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'llmSaveMerge.claudePath': stubPath,
      'llmSaveMerge.timeoutMs': 30000,
      // Auto-save would save dirty buffers mid-test and dissolve the scenarios.
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
    console.log('e2e tests passed');
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
