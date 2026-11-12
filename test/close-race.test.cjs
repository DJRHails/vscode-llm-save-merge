// Leak tests: per-document state must not outlive the document. Async work that was
// started while a document was open (a disk read, a stat) can resolve after
// onDidCloseTextDocument has already dropped its state; if the callback then writes
// state back, nothing ever removes it again. Drives activate() against a minimal mock
// of the vscode API whose disk reads resolve only when the test says so.
// Run: node --expose-gc test/close-race.test.cjs
'use strict';

const assert = require('node:assert');
const Module = require('node:module');

const DOCS = 2000;
const TEXT_BYTES = 50_000; // each leaked snapshot pins one file text of this size
const HEAP_SLACK_BYTES = 20 * 1024 * 1024; // all leaked texts together would be ~100 MB

function emitter() {
  const listeners = new Set();
  const event = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  event.fire = (value) => {
    for (const listener of [...listeners]) listener(value);
  };
  return event;
}

function createMockVscode() {
  const pendingReads = [];
  const liveWatchers = new Set();
  const textDocuments = [];
  const settings = { enabled: true };
  const events = {
    open: emitter(),
    save: emitter(),
    change: emitter(),
    close: emitter(),
    config: emitter(),
  };
  const vscode = {
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      textDocuments,
      getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }),
      createFileSystemWatcher: () => {
        const watcher = {
          onDidChange: emitter(),
          onDidCreate: emitter(),
          dispose: () => liveWatchers.delete(watcher),
        };
        liveWatchers.add(watcher);
        return watcher;
      },
      fs: {
        readFile: (uri) =>
          new Promise((resolve) => pendingReads.push(() => resolve(Buffer.from(uri.disk)))),
        stat: (uri) => new Promise((resolve) => pendingReads.push(() => resolve({ mtime: 1 }))),
      },
      onDidOpenTextDocument: events.open,
      onDidSaveTextDocument: events.save,
      onDidChangeTextDocument: events.change,
      onDidCloseTextDocument: events.close,
      onDidChangeConfiguration: events.config,
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    RelativePattern: class {},
  };
  return { vscode, pendingReads, liveWatchers, textDocuments, settings, events };
}

function loadExtension(mock) {
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'vscode') return mock.vscode;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../extension.js')];
    return require('../extension.js');
  } finally {
    Module._load = originalLoad;
  }
}

function makeDocument(index, { dirty }) {
  // Distinct strings per document so V8 cannot share one backing store between them.
  const text = `${index}:`.padEnd(TEXT_BYTES, String.fromCharCode(97 + (index % 26)));
  const fsPath = `/workspace/file-${index}.md`;
  const uri = { scheme: 'file', fsPath, disk: text, toString: () => `file://${fsPath}` };
  return { uri, version: 1, isDirty: dirty, isClosed: false, getText: () => text };
}

function open(mock, doc) {
  mock.textDocuments.push(doc);
  mock.events.open.fire(doc);
}

function close(mock, doc) {
  doc.isClosed = true;
  mock.textDocuments.splice(mock.textDocuments.indexOf(doc), 1);
  mock.events.close.fire(doc);
}

async function settle(mock) {
  while (mock.pendingReads.length) {
    for (const resolve of mock.pendingReads.splice(0)) resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function heapUsed() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

// Runs one open -> event -> close cycle per document, with every disk read held until
// after the close, and reports heap growth and watchers left alive.
async function churn({ dirty, enabled, afterOpen }) {
  const mock = createMockVscode();
  mock.settings.enabled = enabled;
  const extension = loadExtension(mock);
  const context = { subscriptions: [] };
  extension.activate(context);
  await settle(mock);
  const before = heapUsed();

  for (let i = 0; i < DOCS; i += 1) {
    const doc = makeDocument(i, { dirty });
    open(mock, doc);
    afterOpen?.(mock, doc);
    close(mock, doc); // the close lands while the disk read is still in flight
    await settle(mock);
  }

  const growth = heapUsed() - before;
  const watchers = mock.liveWatchers.size;
  for (const disposable of context.subscriptions) disposable.dispose();
  extension.deactivate();
  return { growth, watchers };
}

// Logs every scenario's numbers before asserting, so one failure does not hide the rest.
function check(results) {
  for (const [name, { growth, watchers }] of results) {
    const mb = (growth / 1024 / 1024).toFixed(1);
    console.log(`${name}: ${DOCS} docs, heap growth ${mb} MB, live watchers ${watchers}`);
  }
  for (const [name, { growth, watchers }] of results) {
    const mb = (growth / 1024 / 1024).toFixed(1);
    const bound = HEAP_SLACK_BYTES / 1024 / 1024;
    assert.ok(growth < HEAP_SLACK_BYTES, `${name}: heap grew ${mb} MB (bound ${bound} MB)`);
    assert.strictEqual(watchers, 0, `${name}: watchers left alive for closed documents`);
  }
}

async function main() {
  assert.ok(global.gc, 'run with node --expose-gc');
  const results = [];

  // A clean buffer reloaded from disk fires a content change; the extension checks the
  // disk before re-basing, and the document closes before that read returns.
  results.push([
    'clean reload then close',
    await churn({
      dirty: false,
      enabled: true,
      afterOpen: (mock, doc) => {
        doc.version += 1;
        mock.events.change.fire({ document: doc, contentChanges: [{}] });
      },
    }),
  ]);

  // A buffer already dirty when opened (restored from backup) seeds its base from disk;
  // with auto-merge disabled no merge ever runs to notice the document is gone.
  results.push([
    'restored-dirty open then close',
    await churn({ dirty: true, enabled: false }),
  ]);

  check(results);
  console.log('close-race tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
