# LLM Save Merge

When a file changes on disk underneath an unsaved (dirty) editor buffer — a parallel
agent session, a formatter, a git operation — VS Code's only offer at save time is the
"content of the file is newer" dialog: Overwrite or Compare. This extension removes that
fork: the moment disk diverges under a dirty buffer, it runs a 3-way LLM merge
(base / your buffer / disk) in the background and swaps the merged result into your
buffer, re-based on the new disk state. By the time you save, there is no conflict.

## Behaviour

- **Trigger**: a watched file changes on disk while its buffer is dirty. Merges are
  debounced and re-checked for staleness (buffer or disk moving during the merge
  retries the merge, up to twice).
- **3-way, not 2-way**: the extension snapshots the disk content each buffer is based
  on (at open, save, and reload), so the model sees the common ancestor. Incompatible
  collisions prefer your buffer; disk-only changes are never dropped.
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
| `llmSaveMerge.timeoutMs` | `120000` | merge call timeout |
| `llmSaveMerge.maxFileBytes` | `400000` | skip files larger than this |

The command palette entry **LLM Save Merge: Merge disk changes into active file** runs a
merge on demand (works even with `enabled` off).

## Build & install

```sh
npx --yes @vscode/vsce package --allow-missing-repository
~/.vscode-server/cli/servers/Stable-*/server/bin/code-server --install-extension llm-save-merge-*.vsix
```

Then reload the VS Code window.
