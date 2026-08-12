# LLM Save Merge

When a file changes on disk underneath an unsaved (dirty) editor buffer — a parallel
agent session, a formatter, a git operation — VS Code's only offer at save time is the
"content of the file is newer" dialog: Overwrite or Compare. This extension removes that
fork: the moment disk diverges under a dirty buffer, it runs a 3-way LLM merge
(base / your buffer / disk) in the background and swaps the merged result into your
buffer, re-based on the new disk state. By the time you save, there is no conflict.

## Behaviour

- **Trigger**: a watched file changes on disk while its buffer is dirty. Three
  detection paths back each other up: file-watcher events; a one-shot disk check when
  a document is first watched (catches divergence from before watching began, e.g. a
  dirty buffer restored from backup); and a 2-second mtime poll over watched dirty
  buffers, because VS Code's workspace file watcher can die — a directory deleted
  mid-scan kills it for the whole window — and it never restarts. Merges are
  debounced and re-checked for staleness (buffer or disk moving during the merge
  retries the merge, up to twice).
- **Excerpt-scoped prompts**: the model receives the original-file excerpt covering
  every change (plus a few context lines) and two unified diffs — original→buffer and
  original→disk — and returns only the merged excerpt, which is spliced back into the
  file mechanically. Before any model call, a runtime invariant checks the splice
  arithmetic: each side's own segment spliced into the original must reproduce that
  side byte-for-byte. Unknown ancestors, changes spanning most of the file, a failed
  invariant, or a rejected excerpt (edge context lines must survive verbatim) fall
  back to the original full three-version prompt.
- **3-way, not 2-way**: the extension snapshots the disk content each buffer is based
  on (at open, save, and reload), so the model sees the common ancestor. Incompatible
  collisions prefer your buffer; disk-only changes are never dropped.
- **Progress you can see and stop**: a merge takes tens of seconds (model latency), so
  it shows a notification with the merge phase and elapsed time, plus a Cancel button
  that kills the model call and leaves the buffer untouched (fail-open, as ever).
- **Disk is never written**: only the buffer is updated. The file on disk changes when
  you save, as usual.
- **Every merge is journalled** to `~/.local/state/llm-save-merge/<timestamp>-<file>/`
  (base, ours, theirs, merged), and the notification offers a disk↔merged diff.
- **Fail open**: timeouts, oversized files (> `maxFileBytes`), or rejected model output
  leave the buffer untouched, so VS Code's normal conflict dialog still protects you.

## Requirements

The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed and
authenticated on the machine where the extension host runs (the remote, for Remote-SSH).

## Settings

| setting | default | meaning |
| --- | --- | --- |
| `llmSaveMerge.enabled` | `true` | auto-merge on disk divergence |
| `llmSaveMerge.model` | `claude-sonnet-5` | model id for `claude --print --model` |
| `llmSaveMerge.claudePath` | `claude` | claude binary (`~/.local/bin` is added to PATH) |
| `llmSaveMerge.timeoutMs` | `240000` | merge call timeout (full-file merges of large files are output-bound and slow) |
| `llmSaveMerge.maxFileBytes` | `400000` | skip files larger than this |

The command palette entry **LLM Save Merge: Merge disk changes into active file** runs a
merge on demand (works even with `enabled` off).

## Tests

```sh
npm test                          # offline: span arithmetic, fallbacks, stubbed CLI
npm run test:live                 # live: real claude CLI, both prompt shapes
xvfb-run -a npm run test:e2e      # e2e: real VS Code, stubbed CLI, conflict-free save
```

The e2e run downloads a VS Code build to `.vscode-test/` on first use, opens a temp
workspace, dirties a buffer, writes the file externally, and asserts the buffer was
auto-merged (both edits present, disk untouched) and that the subsequent save raises
no conflict.

## Build & install

```sh
npx --yes @vscode/vsce package --allow-missing-repository
~/.vscode-server/cli/servers/Stable-*/server/bin/code-server --install-extension llm-save-merge-*.vsix
```

Then reload the VS Code window.
