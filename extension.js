// CommonJS: the VS Code extension host requires a CJS entry point for extensions.
'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { llmMerge } = require('./merge');

const DEBOUNCE_MS = 1200;
const SELF_SAVE_SUPPRESS_MS = 2500;
const MAX_STALE_RETRIES = 2;

const output = vscode.window.createOutputChannel('LLM Save Merge');

// All maps are keyed by uri.toString().
const baseSnapshots = new Map(); // disk content the buffer is currently based on
const watchers = new Map();
const debounceTimers = new Map();
const suppressUntil = new Map(); // ignore watcher events caused by our own saves
const inFlight = new Set();
const pendingRerun = new Set();

function log(message) {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function config() {
  const cfg = vscode.workspace.getConfiguration('llmSaveMerge');
  return {
    enabled: cfg.get('enabled', true),
    model: cfg.get('model', 'claude-sonnet-5'),
    claudePath: cfg.get('claudePath', 'claude'),
    timeoutMs: cfg.get('timeoutMs', 120000),
    maxFileBytes: cfg.get('maxFileBytes', 400000),
  };
}

function isMergeableDocument(doc) {
  return doc.uri.scheme === 'file' && !doc.uri.fsPath.includes(`${path.sep}.git${path.sep}`);
}

function findOpenDocument(key) {
  return vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === key && !doc.isClosed
  );
}

async function readDisk(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function journal(filePath, versions) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(
    os.homedir(), '.local', 'state', 'llm-save-merge',
    `${stamp}-${path.basename(filePath)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filePath);
  const written = {};
  for (const [name, content] of Object.entries(versions)) {
    written[name] = path.join(dir, `${name}${ext}`);
    fs.writeFileSync(written[name], content);
  }
  return written;
}

function ensureWatcher(doc) {
  const key = doc.uri.toString();
  if (watchers.has(key)) return;
  const pattern = new vscode.RelativePattern(
    path.dirname(doc.uri.fsPath),
    path.basename(doc.uri.fsPath)
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onDiskEvent = () => {
    const until = suppressUntil.get(key) ?? 0;
    if (Date.now() < until) return;
    scheduleMerge(key);
  };
  watcher.onDidChange(onDiskEvent);
  watcher.onDidCreate(onDiskEvent); // atomic rename-replace writes surface as create
  watchers.set(key, watcher);
}

function dropFileState(key) {
  watchers.get(key)?.dispose();
  watchers.delete(key);
  clearTimeout(debounceTimers.get(key));
  debounceTimers.delete(key);
  baseSnapshots.delete(key);
  suppressUntil.delete(key);
  pendingRerun.delete(key);
}

function scheduleMerge(key) {
  if (!config().enabled) return;
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      handleDiskChange(key, 0).catch((err) => log(`unhandled: ${err.stack ?? err}`));
    }, DEBOUNCE_MS)
  );
}

function retryLater(key, attempt, reason, basename) {
  if (attempt >= MAX_STALE_RETRIES) {
    log(`${basename}: gave up after ${attempt} retries (${reason})`);
    vscode.window.showWarningMessage(
      `LLM Save Merge: ${basename} kept changing during the merge; ` +
        `falling back to VS Code's conflict handling.`
    );
    return;
  }
  log(`${basename}: ${reason}; retrying (attempt ${attempt + 1})`);
  setTimeout(() => {
    handleDiskChange(key, attempt + 1).catch((err) => log(`unhandled: ${err.stack ?? err}`));
  }, DEBOUNCE_MS);
}

async function handleDiskChange(key, attempt) {
  const doc = findOpenDocument(key);
  if (!doc) return dropFileState(key);
  if (!doc.isDirty) return; // VS Code auto-reloads clean buffers itself

  let theirs;
  try {
    theirs = await readDisk(doc.uri);
  } catch {
    return; // file deleted on disk; nothing sane to merge against
  }
  const ours = doc.getText();
  if (theirs === ours) {
    baseSnapshots.set(key, theirs);
    return;
  }
  const base = baseSnapshots.get(key) ?? '';
  if (theirs === base) return; // mtime-only touch; buffer is just normally dirty

  const cfg = config();
  const basename = path.basename(doc.uri.fsPath);
  const tooBig = [base, ours, theirs].some((v) => v.length > cfg.maxFileBytes);
  if (tooBig) {
    log(`${basename}: exceeds maxFileBytes (${cfg.maxFileBytes}); skipping`);
    return;
  }
  if (inFlight.has(key)) {
    pendingRerun.add(key);
    return;
  }

  inFlight.add(key);
  const status = vscode.window.setStatusBarMessage(`$(sync~spin) LLM-merging ${basename}…`);
  try {
    await performMerge({ doc, key, base, ours, theirs, cfg, basename, attempt });
  } catch (err) {
    log(`${basename}: merge failed: ${err.stack ?? err}`);
    vscode.window.showWarningMessage(
      `LLM Save Merge failed for ${basename} (${err.message}). ` +
        `VS Code's normal conflict dialog will apply on save.`
    );
  } finally {
    inFlight.delete(key);
    status.dispose();
    if (pendingRerun.delete(key)) scheduleMerge(key);
  }
}

async function performMerge({ doc, key, base, ours, theirs, cfg, basename, attempt }) {
  const versionBefore = doc.version;
  log(`${basename}: merging (base ${base.length}B, ours ${ours.length}B, theirs ${theirs.length}B)`);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: doc.uri.fsPath,
    model: cfg.model,
    claudePath: cfg.claudePath,
    timeoutMs: cfg.timeoutMs,
  });

  if (doc.isClosed) return;
  if (doc.version !== versionBefore) {
    return retryLater(key, attempt, 'buffer changed during merge', basename);
  }
  if ((await readDisk(doc.uri)) !== theirs) {
    return retryLater(key, attempt, 'disk changed again during merge', basename);
  }

  const journalled = journal(doc.uri.fsPath, { base, ours, theirs, merged });
  await rebaseBufferOnDisk(doc, key, theirs, ours);
  if (merged !== theirs && !(await replaceAll(doc, merged))) {
    await replaceAll(doc, ours); // restore the user's buffer rather than lose it
    throw new Error('applying the merged text failed; buffer restored');
  }
  log(`${basename}: merged (${merged.length}B); journal at ${path.dirname(journalled.merged)}`);
  notifyMerged(doc, basename, journalled);
}

// Revert re-bases the document on the current disk content so a later save no longer
// trips the "content of the file is newer" conflict. The user's text is restored by
// the merged replaceAll that follows; `ours` is already journalled if anything fails.
async function rebaseBufferOnDisk(doc, key, theirs, ours) {
  await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
  if (doc.getText() !== theirs && doc.getText() === ours && doc.isDirty) {
    // Revert ignored the uri argument on this VS Code build; retry via the active editor.
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  baseSnapshots.set(key, theirs);
}

async function replaceAll(doc, text) {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, fullRange, text);
  return vscode.workspace.applyEdit(edit);
}

function notifyMerged(doc, basename, journalled) {
  const action = 'Review diff';
  vscode.window
    .showInformationMessage(
      `LLM-merged disk changes into ${basename} (buffer updated, not yet saved).`,
      action
    )
    .then((choice) => {
      if (choice !== action) return;
      vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(journalled.theirs),
        doc.uri,
        `${basename}: disk ↔ merged buffer`
      );
    });
}

async function mergeActiveFile() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !isMergeableDocument(doc)) {
    return vscode.window.showInformationMessage('LLM Save Merge: no mergeable file active.');
  }
  if (!doc.isDirty) {
    return vscode.window.showInformationMessage('LLM Save Merge: buffer is clean.');
  }
  await handleDiskChange(doc.uri.toString(), MAX_STALE_RETRIES - 1);
}

function snapshotExistingDocuments() {
  for (const doc of vscode.workspace.textDocuments) {
    if (!isMergeableDocument(doc)) continue;
    const key = doc.uri.toString();
    if (!doc.isDirty) {
      baseSnapshots.set(key, doc.getText());
    } else {
      // Best effort for buffers already dirty at activation: current disk is the
      // closest available ancestor.
      readDisk(doc.uri)
        .then((disk) => baseSnapshots.set(key, disk))
        .catch(() => {});
      ensureWatcher(doc);
    }
  }
}

function activate(context) {
  snapshotExistingDocuments();
  context.subscriptions.push(
    output,
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMergeableDocument(doc)) baseSnapshots.set(doc.uri.toString(), doc.getText());
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isMergeableDocument(doc)) return;
      const key = doc.uri.toString();
      baseSnapshots.set(key, doc.getText());
      suppressUntil.set(key, Date.now() + SELF_SAVE_SUPPRESS_MS);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!isMergeableDocument(doc)) return;
      if (!doc.isDirty) {
        // Covers auto-reload of clean buffers, undo-back-to-saved, and our own revert.
        baseSnapshots.set(doc.uri.toString(), doc.getText());
        return;
      }
      ensureWatcher(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => dropFileState(doc.uri.toString())),
    vscode.commands.registerCommand('llmSaveMerge.mergeActiveFile', mergeActiveFile)
  );
  log('activated');
}

function deactivate() {
  for (const watcher of watchers.values()) watcher.dispose();
  watchers.clear();
}

module.exports = { activate, deactivate };
