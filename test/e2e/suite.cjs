// Runs inside the VS Code extension host (launched by run.cjs). Contract: export a
// single run() that rejects on failure.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const scenario = require('./scenario.cjs');

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

async function run() {
  const workspace = process.env.LSM_E2E_WORKSPACE;
  assert.ok(workspace, 'LSM_E2E_WORKSPACE is set');
  const filePath = path.join(workspace, 'doc.md');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc);

  // Diagnostics: record every document event so a failure explains itself.
  const events = [];
  vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document !== doc) return;
    events.push(
      `change: dirty=${event.document.isDirty} changes=${event.contentChanges.length} ` +
        `len=${event.document.getText().length}`
    );
  });
  vscode.workspace.onDidSaveTextDocument((saved) => {
    if (saved === doc) events.push(`save: len=${saved.getText().length}`);
  });

  // Dirty the buffer: replace line 15 (0-indexed 14) with the OURS edit.
  const target = doc.lineAt(14);
  assert.strictEqual(target.text, 'line 15');
  const applied = await editor.edit((edit) => edit.replace(target.range, scenario.OURS_LINE));
  assert.ok(applied && doc.isDirty, 'buffer is dirty after the edit');

  await sleep(500); // let the extension attach its watcher
  fs.writeFileSync(filePath, scenario.theirsText()); // the external write

  await waitFor(() => doc.getText() === scenario.expectedMerged(), 30000, 'the auto-merge').catch(
    (err) => {
      console.error(`document events seen:\n${events.join('\n')}`);
      throw err;
    }
  );
  assert.ok(doc.isDirty, 'merge updates the buffer without writing disk');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), scenario.theirsText(), 'disk untouched');

  const journalRoot = path.join(process.env.HOME, '.local', 'state', 'llm-save-merge');
  assert.ok(fs.readdirSync(journalRoot).length >= 1, 'merge was journalled');

  // The end-to-end point: saving now succeeds — no "content of the file is newer" dialog.
  assert.ok(await doc.save(), 'save succeeds without a conflict');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), scenario.expectedMerged());
  console.log('e2e: dirty buffer + external write auto-merged; save was conflict-free');
}

module.exports = { run };
