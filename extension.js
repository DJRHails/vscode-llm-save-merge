// CommonJS: the VS Code extension host requires a CJS entry point for extensions.
'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { llmMerge, parseDotenv } = require('./merge');

const DEBOUNCE_MS = 1200;
const SELF_SAVE_SUPPRESS_MS = 2500;
const MAX_STALE_RETRIES = 2;
const POLL_MS = 2000;
// After claude fails to authenticate, every further auto-merge would fail the same way
// and pop the same dialog on each disk change; pause them until the user acts.
const AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

const output = vscode.window.createOutputChannel('LLM Save Merge');

// All maps are keyed by uri.toString().
const baseSnapshots = new Map(); // disk content the buffer is currently based on
const watchers = new Map();
const debounceTimers = new Map();
const suppressUntil = new Map(); // ignore watcher events caused by our own saves
// key -> in-flight merge context: { versionBefore, theirs, cancelStale, staleWhy }.
// cancelStale kills the model call when the inputs it was given stop being current.
const inFlight = new Map();
const pendingRerun = new Set();
const lastMtimes = new Map();
// Bases seeded from current disk for buffers that were ALREADY dirty when first seen
// (restored from backup): the true ancestor is unknowable, so these are guesses.
const provisionalBases = new Set();
let pollTimer;
let pollInFlight = false;
let authFailedAt = 0; // epoch ms of the last claude auth failure; 0 when auth is fine

function log(message) {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function config() {
  const cfg = vscode.workspace.getConfiguration('llmSaveMerge');
  return {
    enabled: cfg.get('enabled', true),
    model: cfg.get('model', 'claude-sonnet-5'),
    claudePath: cfg.get('claudePath', 'claude'),
    timeoutMs: cfg.get('timeoutMs', 240000),
    maxFileBytes: cfg.get('maxFileBytes', 400000),
    envFile: cfg.get('envFile', ''),
  };
}

// The extension host inherits the VS Code server's login environment, not the user's
// interactive shell: anything a shell function or rc file exports (an API key, a
// CLAUDE_CONFIG_DIR) is missing here, and the claude child then fails to authenticate.
// An optional dotenv file bridges that gap; it is re-read on every merge so edits apply
// without a reload. A configured file that cannot be read is an error, not a silent
// fall-through to an unauthenticated call.
function loadExtraEnv(envFile, basename) {
  if (!envFile) return {};
  const resolved = envFile.replace(/^~(?=$|[\\/])/, os.homedir());
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const problem = new Error(
      `llmSaveMerge.envFile ${resolved} is not readable (${err.code ?? err.message})`
    );
    problem.config = true;
    throw problem;
  }
  const extraEnv = parseDotenv(text);
  const names = Object.keys(extraEnv);
  log(`${basename}: envFile ${resolved} sets ${names.length ? names.join(', ') : 'nothing'}`);
  return extraEnv;
}

function excerptForLog(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '(empty)';
  const limit = 2000;
  if (trimmed.length <= limit) return trimmed;
  return `(${trimmed.length} chars; last ${limit})\n${trimmed.slice(-limit)}`;
}

// Every failure lands in the output channel in full (exit code, both streams, the
// credentials the child saw) and in a dialog that says what to do about it.
function reportFailure(basename, err) {
  const showLog = 'Show log';
  const openSettings = 'Open settings';
  log(`${basename}: merge failed: ${err.message}`);
  if (err.exitCode !== undefined) {
    log(`  ${err.signal ? `killed by ${err.signal}` : `exit code ${err.exitCode}`}`);
    log(`  auth: ${err.authSources}`);
    log(`  stderr: ${excerptForLog(err.stderr)}`);
    log(`  stdout: ${excerptForLog(err.stdout)}`);
  } else if (!err.config) {
    log(`  ${err.stack ?? err}`);
  }

  let message;
  let actions;
  if (err.auth) {
    authFailedAt = Date.now();
    const minutes = AUTH_FAILURE_COOLDOWN_MS / 60000;
    message =
      `LLM Save Merge: claude is not authenticated: ${err.detail} [${err.authSources}]. ` +
      `Merges run claude in bare mode, which reads only ANTHROPIC_API_KEY: point ` +
      `llmSaveMerge.envFile at a dotenv exporting it. Auto-merges pause for ${minutes} ` +
      `min; the palette command still runs.`;
    actions = [showLog, openSettings];
  } else if (err.config) {
    message = `LLM Save Merge: ${err.message}.`;
    actions = [showLog, openSettings];
  } else {
    message =
      `LLM Save Merge failed for ${basename}: ${err.message}. ` +
      `VS Code's normal conflict dialog will apply on save.`;
    actions = [showLog];
  }
  vscode.window.showWarningMessage(message, ...actions).then((choice) => {
    if (choice === showLog) output.show(true);
    if (choice === openSettings) {
      vscode.commands.executeCommand('workbench.action.openSettings', 'llmSaveMerge');
    }
  });
}

function authPauseRemainingMs() {
  if (!authFailedAt) return 0;
  return Math.max(0, AUTH_FAILURE_COOLDOWN_MS - (Date.now() - authFailedAt));
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

// Record an authoritative base: buffer text known to match a real disk state.
function settleBase(key, text) {
  baseSnapshots.set(key, text);
  provisionalBases.delete(key);
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
  provisionalBases.delete(key);
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

function retryLater(key, attempt, reason, basename, manual) {
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
    handleDiskChange(key, attempt + 1, manual).catch(
      (err) => log(`unhandled: ${err.stack ?? err}`)
    );
  }, DEBOUNCE_MS);
}

async function handleDiskChange(key, attempt, manual = false) {
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
    settleBase(key, theirs);
    return;
  }
  let base = baseSnapshots.get(key) ?? '';
  if (theirs === base) {
    if (!manual || !provisionalBases.has(key)) {
      // Mtime-only touch, or the watch-start check on an unchanged disk.
      log(`${basename}: disk matches the base snapshot; buffer is just dirty`);
      return;
    }
    // A restored-dirty buffer: base was seeded from current disk, so the true
    // ancestor is unknown — divergence from before the restore is invisible here.
    // The user explicitly asked to merge, so run ancestor-less: the full-file
    // prompt combines buffer and disk faithfully when base is empty.
    log(`${basename}: manual merge with unknown ancestor; combining buffer and disk`);
    base = '';
  }

  const cfg = config();
  const tooBig = [base, ours, theirs].some((v) => v.length > cfg.maxFileBytes);
  if (tooBig) {
    log(`${basename}: exceeds maxFileBytes (${cfg.maxFileBytes}); skipping`);
    return;
  }
  const pauseMs = manual ? 0 : authPauseRemainingMs();
  if (pauseMs > 0) {
    log(
      `${basename}: auto-merge paused after a claude auth failure ` +
        `(${Math.ceil(pauseMs / 60000)} min left); fix auth, then use the palette command`
    );
    return;
  }
  const alreadyRunning = inFlight.get(key);
  if (alreadyRunning) {
    pendingRerun.add(key);
    if (theirs !== alreadyRunning.theirs) {
      // Disk moved past the inputs the running merge was given: its result is
      // pre-doomed, so kill the model call now instead of after the timeout.
      alreadyRunning.cancelStale?.('disk changed during the model call');
    }
    return;
  }

  const running = { versionBefore: doc.version, theirs, cancelStale: null, staleWhy: null };
  inFlight.set(key, running);
  try {
    await mergeWithProgress({
      doc,
      key,
      base,
      ours,
      theirs,
      cfg,
      basename,
      attempt,
      manual,
      running,
    });
  } catch (err) {
    if (err.cancelled && running.staleWhy) {
      // Cancelled by us, not the user: the reschedule is already queued (the
      // canceller sets pendingRerun, drained by the finally below).
      log(`${basename}: merge call killed (${running.staleWhy}); rescheduling`);
    } else if (err.cancelled) {
      log(`${basename}: merge cancelled by user`);
    } else if (err.stale) {
      retryLater(key, attempt, 'inputs went stale during the merge', basename, manual);
    } else {
      reportFailure(basename, err);
    }
  } finally {
    inFlight.delete(key);
    if (pendingRerun.delete(key)) scheduleMerge(key);
  }
}

// The UI token fires on the notification's Cancel button; the composed token also lets
// the staleness cancellers kill the model call when the inputs stop being current.
function composeCancellation(uiToken) {
  const listeners = new Set();
  let requested = false;
  const request = () => {
    if (requested) return;
    requested = true;
    for (const listener of [...listeners]) listener();
  };
  const relay = uiToken.onCancellationRequested(request);
  return {
    get isCancellationRequested() {
      return requested || uiToken.isCancellationRequested;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    request,
    dispose: () => relay.dispose(),
  };
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
    (progress, uiToken) => {
      const startedAt = Date.now();
      const phase = { label: 'merging' };
      const timeoutSeconds = Math.round(job.cfg.timeoutMs / 1000);
      const cancellation = composeCancellation(uiToken);
      job.running.cancelStale = (why) => {
        if (job.running.staleWhy) return;
        job.running.staleWhy = why;
        cancellation.request();
      };
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        progress.report({ message: `${phase.label} — ${elapsed}s (timeout ${timeoutSeconds}s)` });
      }, 1000);
      return performMerge({ ...job, cancellation, phase }).finally(() => {
        clearInterval(ticker);
        cancellation.dispose();
      });
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
  manual,
  running,
  cancellation,
  phase,
}) {
  const versionBefore = doc.version;
  log(`${basename}: merging (base ${base.length}B, ours ${ours.length}B, theirs ${theirs.length}B)`);
  const extraEnv = loadExtraEnv(cfg.envFile, basename);

  const merged = await llmMerge({
    base,
    ours,
    theirs,
    filePath: doc.uri.fsPath,
    model: cfg.model,
    claudePath: cfg.claudePath,
    timeoutMs: cfg.timeoutMs,
    extraEnv,
    cancellation,
    isStale: async () => {
      if (doc.isClosed || doc.version !== versionBefore) return true;
      try {
        return (await readDisk(doc.uri)) !== theirs;
      } catch {
        return true;
      }
    },
    log: (message) => {
      log(`${basename}: ${message}`);
      if (phase && message.startsWith('excerpt merge:')) phase.label = 'excerpt merge';
      if (phase && message.startsWith('excerpt merge failed')) phase.label = 'full-file merge';
    },
  });

  // The model call is done: disarm the staleness canceller so our own revert and
  // replace below (which fire change events) cannot kill their own merge. Staleness
  // from here on is handled by the version and disk checks.
  if (running) running.cancelStale = null;
  authFailedAt = 0; // the model answered, so credentials work again

  if (doc.isClosed) return;
  if (doc.version !== versionBefore) {
    return retryLater(key, attempt, 'buffer changed during merge', basename, manual);
  }
  if ((await readDisk(doc.uri)) !== theirs) {
    return retryLater(key, attempt, 'disk changed again during merge', basename, manual);
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
  settleBase(key, theirs);
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
    log('manual merge requested: no mergeable file active');
    return vscode.window.showInformationMessage('LLM Save Merge: no mergeable file active.');
  }
  if (!doc.isDirty) {
    log(`manual merge requested: ${path.basename(doc.uri.fsPath)} is clean`);
    return vscode.window.showInformationMessage('LLM Save Merge: buffer is clean.');
  }
  log(`${path.basename(doc.uri.fsPath)}: manual merge requested`);
  await handleDiskChange(doc.uri.toString(), MAX_STALE_RETRIES - 1, true);
}

function trackDocument(doc) {
  if (!isMergeableDocument(doc)) return;
  const key = doc.uri.toString();
  if (!doc.isDirty) {
    settleBase(key, doc.getText());
    return;
  }
  // Dirty before we ever saw a clean version (restored from backup, or already dirty
  // at activation): the true ancestor is unknowable, so current disk is the closest
  // available one. Never use the dirty buffer text as base — a later merge would then
  // read the user's edits as "no change on our side" and resolve to plain disk.
  readDisk(doc.uri)
    .then((disk) => {
      if (!baseSnapshots.has(key)) {
        baseSnapshots.set(key, disk);
        provisionalBases.add(key);
      }
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
      settleBase(key, doc.getText());
      suppressUntil.set(key, Date.now() + SELF_SAVE_SUPPRESS_MS);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!isMergeableDocument(doc)) return;
      const key = doc.uri.toString();
      const running = inFlight.get(key);
      if (
        running?.cancelStale &&
        event.contentChanges.length > 0 &&
        doc.version !== running.versionBefore
      ) {
        // The buffer moved while a merge was mid-call: the result would fail the
        // version check anyway, so kill the call now and re-merge with fresh text.
        pendingRerun.add(key);
        running.cancelStale('buffer changed during the model call');
      }
      if (doc.isDirty) {
        ensureWatcher(doc);
        return;
      }
      const text = doc.getText();
      if (event.contentChanges.length === 0) {
        // An empty change on a clean document is a dirty-state flip (save, revert,
        // undo back to saved): buffer equals disk, safe to re-base directly.
        settleBase(key, text);
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
          if (disk === text) settleBase(key, text);
        })
        .catch(() => {});
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => dropFileState(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('llmSaveMerge') || !authFailedAt) return;
      // A settings change is the user acting on the auth dialog: let the next
      // auto-merge try the new configuration instead of waiting out the pause.
      authFailedAt = 0;
      log('configuration changed; auth pause cleared');
    }),
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
