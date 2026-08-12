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
const POLL_MS = 2000;

const output = vscode.window.createOutputChannel('LLM Save Merge');

// All maps are keyed by uri.toString().
const baseSnapshots = new Map(); // disk content the buffer is currently based on
const watchers = new Map();
const debounceTimers = new Map();
const suppressUntil = new Map(); // ignore watcher events caused by our own saves
const inFlight = new Set();
const pendingRerun = new Set();
const lastMtimes = new Map();
let pollTimer;
let pollInFlight = false;

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
  log(`${path.basename(doc.uri.fsPath)}: watching for disk changes`);
  vscode.workspace.fs.stat(doc.uri).then(
    (stat) => lastMtimes.set(key, stat.mtime),
    () => {}
  );
  // The disk may already have diverged before this watcher existed (a buffer restored
  // from backup, or a change that arrived while nothing was watching): check once now.
  scheduleMerge(key);
}

function dropFileState(key) {
  watchers.get(key)?.dispose();
  watchers.delete(key);
  clearTimeout(debounceTimers.get(key));
  debounceTimers.delete(key);
  baseSnapshots.delete(key);
  suppressUntil.delete(key);
  pendingRerun.delete(key);
  lastMtimes.delete(key);
}

// Fallback trigger: VS Code's workspace file watcher can die (e.g. a directory deleted
// mid-scan kills the parcel watcher for the whole window) and it never restarts. When
// that happens createFileSystemWatcher goes silent with it, so dirty watched buffers
// are additionally polled by mtime. Content checks in handleDiskChange make a spurious
// wake-up free, so false positives here are harmless.
async function pollWatchedDocuments() {
  if (pollInFlight || !config().enabled) return;
  pollInFlight = true;
  try {
    for (const key of watchers.keys()) {
      const doc = findOpenDocument(key);
      if (!doc || !doc.isDirty) continue;
      let mtime;
      try {
        mtime = (await vscode.workspace.fs.stat(doc.uri)).mtime;
      } catch {
        continue; // deleted on disk; nothing sane to merge against
      }
      const last = lastMtimes.get(key);
      lastMtimes.set(key, mtime);
      if (last === undefined || mtime === last) continue;
      if (Date.now() < (suppressUntil.get(key) ?? 0)) continue;
      log(`${path.basename(doc.uri.fsPath)}: disk mtime changed (poll fallback)`);
      scheduleMerge(key);
    }
  } finally {
    pollInFlight = false;
  }
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
  const basename = path.basename(doc.uri.fsPath);
  if (!doc.isDirty) {
    log(`${basename}: disk changed under a clean buffer; leaving the reload to VS Code`);
    return;
  }

  let theirs;
  try {
    theirs = await readDisk(doc.uri);
  } catch {
    log(`${basename}: unreadable or deleted on disk; skipping`);
    return;
  }
  const ours = doc.getText();
  if (theirs === ours) {
    log(`${basename}: buffer already matches disk; re-basing`);
    baseSnapshots.set(key, theirs);
    return;
  }
  const base = baseSnapshots.get(key) ?? '';
  if (theirs === base) return; // mtime-only touch (or watch-start check); just dirty

  const cfg = config();
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
  try {
    await mergeWithProgress({ doc, key, base, ours, theirs, cfg, basename, attempt });
  } catch (err) {
    if (err.cancelled) {
      log(`${basename}: merge cancelled by user`);
    } else {
      log(`${basename}: merge failed: ${err.stack ?? err}`);
      vscode.window.showWarningMessage(
        `LLM Save Merge failed for ${basename} (${err.message}). ` +
          `VS Code's normal conflict dialog will apply on save.`
      );
    }
  } finally {
    inFlight.delete(key);
    if (pendingRerun.delete(key)) scheduleMerge(key);
  }
}

// A merge takes tens of seconds (model latency), so it gets a real notification with
// elapsed time, the current phase, and a cancel button — not a status-bar whisper.
function mergeWithProgress(job) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `LLM-merging ${job.basename}`,
      cancellable: true,
    },
    (progress, cancellation) => {
      const startedAt = Date.now();
      const phase = { label: 'merging' };
      const timeoutSeconds = Math.round(job.cfg.timeoutMs / 1000);
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        progress.report({ message: `${phase.label} — ${elapsed}s (timeout ${timeoutSeconds}s)` });
      }, 1000);
      return performMerge({ ...job, cancellation, phase }).finally(() => clearInterval(ticker));
    }
  );
}

async function performMerge({
  doc,
  key,
  base,
  ours,
  theirs,
  cfg,
  basename,
  attempt,
  cancellation,
  phase,
}) {
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
    cancellation,
    log: (message) => {
      log(`${basename}: ${message}`);
      if (phase && message.startsWith('excerpt merge:')) phase.label = 'excerpt merge';
      if (phase && message.startsWith('excerpt merge failed')) phase.label = 'full-file merge';
    },
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

function trackDocument(doc) {
  if (!isMergeableDocument(doc)) return;
  const key = doc.uri.toString();
  if (!doc.isDirty) {
    baseSnapshots.set(key, doc.getText());
    return;
  }
  // Dirty before we ever saw a clean version (restored from backup, or already dirty
  // at activation): the true ancestor is unknowable, so current disk is the closest
  // available one. Never use the dirty buffer text as base — a later merge would then
  // read the user's edits as "no change on our side" and resolve to plain disk.
  readDisk(doc.uri)
    .then((disk) => {
      if (!baseSnapshots.has(key)) baseSnapshots.set(key, disk);
      ensureWatcher(doc);
    })
    .catch(() => {});
}

function activate(context) {
  for (const doc of vscode.workspace.textDocuments) trackDocument(doc);
  pollTimer = setInterval(() => {
    pollWatchedDocuments().catch((err) => log(`poll: ${err.stack ?? err}`));
  }, POLL_MS);
  context.subscriptions.push(
    output,
    { dispose: () => clearInterval(pollTimer) },
    vscode.workspace.onDidOpenTextDocument(trackDocument),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isMergeableDocument(doc)) return;
      const key = doc.uri.toString();
      baseSnapshots.set(key, doc.getText());
      suppressUntil.set(key, Date.now() + SELF_SAVE_SUPPRESS_MS);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!isMergeableDocument(doc)) return;
      if (doc.isDirty) {
        ensureWatcher(doc);
        return;
      }
      const key = doc.uri.toString();
      const text = doc.getText();
      if (event.contentChanges.length === 0) {
        // An empty change on a clean document is a dirty-state flip (save, revert,
        // undo back to saved): buffer equals disk, safe to re-base directly.
        baseSnapshots.set(key, text);
        return;
      }
      // A content change on a "clean" document is ambiguous: a real edit can arrive
      // with isDirty still false — the dirty flip follows as a separate empty event
      // (observed on VS Code 1.133) — and re-basing on it would poison base with the
      // edited text, making a later merge resolve to plain disk and drop the edits.
      // Trust the text only if disk confirms it (true for auto-reload of clean
      // buffers, false for the mid-transition edit event).
      readDisk(doc.uri)
        .then((disk) => {
          if (disk === text) baseSnapshots.set(key, text);
        })
        .catch(() => {});
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => dropFileState(doc.uri.toString())),
    vscode.commands.registerCommand('llmSaveMerge.mergeActiveFile', mergeActiveFile)
  );
  log('activated (watcher + watch-start check + mtime poll)');
}

function deactivate() {
  clearInterval(pollTimer);
  for (const watcher of watchers.values()) watcher.dispose();
  watchers.clear();
}

module.exports = { activate, deactivate };
