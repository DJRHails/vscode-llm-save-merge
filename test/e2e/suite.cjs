// Runs inside the VS Code extension host (launched by run.cjs). Contract: export a
// single run() that rejects on failure. Scenarios run sequentially in one instance;
// each owns its doc<N>.md and its stub replies (routed by <file_path>).
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const scenario = require('./scenario.cjs');

const MERGE_WAIT_MS = 30000;
const QUIET_WAIT_MS = 4000; // > debounce (1.2s) + poll interval (2s)

const events = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function recordEvents() {
  vscode.workspace.onDidChangeTextDocument((event) => {
    const name = path.basename(event.document.uri.fsPath);
    events.push(
      `${name} change: dirty=${event.document.isDirty} ` +
        `changes=${event.contentChanges.length} len=${event.document.getText().length}`
    );
  });
  vscode.workspace.onDidSaveTextDocument((doc) => {
    events.push(`${path.basename(doc.uri.fsPath)} save: len=${doc.getText().length}`);
  });
}

function stubCalls(doc) {
  return fs.readdirSync(process.env.STUB_DIR).filter((f) => f.startsWith(`call-${doc}-`));
}

async function openAndEdit(workspace, doc, oursLine) {
  const filePath = path.join(workspace, `${doc}.md`);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document);
  const target = document.lineAt(oursLine[0] - 1);
  const applied = await editor.edit((edit) => edit.replace(target.range, oursLine[1]));
  assert.ok(applied && document.isDirty, `${doc}: buffer is dirty after the edit`);
  await sleep(500); // let the extension attach its watcher
  return { document, filePath };
}

// The basic path: dirty buffer + external write, excerpt auto-merge, conflict-free save.
async function excerptMerge(workspace) {
  const sc = scenario.excerptMerge;
  const { document, filePath } = await openAndEdit(workspace, sc.doc, sc.oursLine);
  fs.writeFileSync(filePath, scenario.theirs(sc));

  await waitFor(() => document.getText() === scenario.merged(sc), MERGE_WAIT_MS, 'auto-merge');
  assert.ok(document.isDirty, `${sc.doc}: merge updates the buffer without writing disk`);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), scenario.theirs(sc), 'disk untouched');
  assert.strictEqual(stubCalls(sc.doc).length, 1, 'exactly one model call');

  const journalRoot = path.join(process.env.HOME, '.local', 'state', 'llm-save-merge');
  assert.ok(fs.readdirSync(journalRoot).length >= 1, 'merge was journalled');

  assert.ok(await document.save(), `${sc.doc}: save succeeds without a conflict`);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), scenario.merged(sc));
  console.log('scenario excerpt-merge passed');
}

// A corrupted excerpt reply must fall back to the full-file prompt and still merge.
async function fullFileFallback(workspace) {
  const sc = scenario.fullFileFallback;
  const { document, filePath } = await openAndEdit(workspace, sc.doc, sc.oursLine);
  fs.writeFileSync(filePath, scenario.theirs(sc));

  await waitFor(
    () => document.getText() === scenario.merged(sc),
    MERGE_WAIT_MS,
    'fallback merge'
  );
  assert.strictEqual(stubCalls(sc.doc).length, 2, 'excerpt call then full-file call');
  const secondArgs = fs.readFileSync(
    path.join(process.env.STUB_DIR, `args-${sc.doc}-1.txt`),
    'utf8'
  );
  assert.ok(
    secondArgs.includes('three-way merge of a text file'),
    'second call used the full-file instruction'
  );
  console.log('scenario full-file-fallback passed');
}

// An external write under a CLEAN buffer auto-reloads it; the merge that follows must
// use the reloaded content as base (a stale base would change the excerpt span and
// fail this scenario's baked reply).
async function reloadThenMerge(workspace) {
  const sc = scenario.reloadThenMerge;
  const filePath = path.join(workspace, `${sc.doc}.md`);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document);
  await sleep(500);

  fs.writeFileSync(filePath, sc.v2); // clean buffer: VS Code auto-reloads
  await waitFor(() => document.getText() === sc.v2, MERGE_WAIT_MS, 'clean-buffer reload');
  assert.strictEqual(stubCalls(sc.doc).length, 0, 'reload alone calls no model');

  const editor = await vscode.window.showTextDocument(document);
  const target = document.lineAt(sc.oursLine[0] - 1);
  const applied = await editor.edit((edit) => edit.replace(target.range, sc.oursLine[1]));
  assert.ok(applied && document.isDirty, `${sc.doc}: buffer dirty after post-reload edit`);
  await sleep(500);
  fs.writeFileSync(filePath, scenario.theirs(sc, sc.v2));

  await waitFor(
    () => document.getText() === scenario.merged(sc, sc.v2),
    MERGE_WAIT_MS,
    'post-reload merge (fails if base was not re-based on the reload)'
  );
  assert.strictEqual(stubCalls(sc.doc).length, 1, 'one model call for the merge');
  console.log('scenario reload-then-merge passed');
}

// Rewriting identical content (mtime-only touch) must not merge or call the model.
async function mtimeOnlyTouch(workspace) {
  const sc = scenario.mtimeOnlyTouch;
  const { document, filePath } = await openAndEdit(workspace, sc.doc, sc.oursLine);
  fs.writeFileSync(filePath, sc.base); // same content, new mtime

  await sleep(QUIET_WAIT_MS);
  assert.strictEqual(document.getText(), scenario.ours(sc), 'buffer untouched');
  assert.ok(document.isDirty, `${sc.doc}: buffer still dirty`);
  assert.strictEqual(stubCalls(sc.doc).length, 0, 'no model call for an mtime-only touch');
  console.log('scenario mtime-only-touch passed');
}

// With auto-merge disabled nothing fires on divergence; the palette command still merges.
async function manualCommand(workspace) {
  const config = vscode.workspace.getConfiguration('llmSaveMerge');
  await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
  try {
    const sc = scenario.manualCommand;
    const { document, filePath } = await openAndEdit(workspace, sc.doc, sc.oursLine);
    fs.writeFileSync(filePath, scenario.theirs(sc));

    await sleep(QUIET_WAIT_MS);
    assert.strictEqual(document.getText(), scenario.ours(sc), 'disabled: no auto-merge');
    assert.strictEqual(stubCalls(sc.doc).length, 0, 'disabled: no model call');

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('llmSaveMerge.mergeActiveFile');
    await waitFor(
      () => document.getText() === scenario.merged(sc),
      MERGE_WAIT_MS,
      'manual merge'
    );
    assert.strictEqual(stubCalls(sc.doc).length, 1, 'manual command made one model call');
    console.log('scenario manual-command passed');
  } finally {
    await config.update('enabled', undefined, vscode.ConfigurationTarget.Workspace);
  }
}

async function run() {
  const workspace = process.env.LSM_E2E_WORKSPACE;
  assert.ok(workspace, 'LSM_E2E_WORKSPACE is set');
  recordEvents();
  try {
    await excerptMerge(workspace);
    await fullFileFallback(workspace);
    await reloadThenMerge(workspace);
    await mtimeOnlyTouch(workspace);
    await manualCommand(workspace);
  } catch (err) {
    console.error(`document events seen:\n${events.join('\n')}`);
    throw err;
  }
  console.log('e2e: all scenarios passed');
}

module.exports = { run };
