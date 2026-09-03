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
- **Mechanical first, model for disputes only**: the two sides' edits are diffed
  against the ancestor as hunks, and any hunk that touches no hunk of the other side
  (diff3's rule: an unchanged line must separate them) is applied directly — as is a
  hunk both sides made identically. When nothing is disputed, that is the merge: no
  model call, milliseconds, byte-identical to `git merge-file` (the test suite checks
  this against git on seeded random edit pairs). Every merge this extension had ever
  journalled was of that kind, and had been costing 30 s to 5 min of model time.
- **Excerpt-scoped prompts for what is left**: when the sides do dispute a region, the
  model receives the three versions *with every settled hunk already applied*, cut down
  to the excerpt covering the disputed hunks (plus a few context lines) and two unified
  diffs — original→buffer and original→disk — and returns only the merged excerpt,
  which is spliced back into the file mechanically. Before any model call, a runtime
  invariant checks the splice arithmetic: each side's own segment spliced into the
  original must reproduce that side byte-for-byte. Unknown ancestors, disputes spanning
  most of the file, a failed invariant, or a rejected excerpt (edge context lines must
  survive verbatim) fall back to the full three-version prompt.
- **A lean model call**: `claude` runs in `--bare` mode with no tools, MCP servers,
  hooks, plugins, or CLAUDE.md — a merge needs none of them, and together they had cost
  ~13 s and a 54k-token system prompt per call.
- **3-way, not 2-way**: the extension snapshots the disk content each buffer is based
  on (at open, save, and reload), so the model sees the common ancestor. Incompatible
  collisions prefer your buffer; disk-only changes are never dropped.
- **Progress you can see and stop**: a model call takes tens of seconds, so a merge
  shows a notification with the merge phase and elapsed time, plus a Cancel button
  that kills the model call and leaves the buffer untouched (fail-open, as ever).
- **Stale calls die immediately**: if the buffer is edited or the disk changes again
  while a model call is in flight, the call is killed on the spot — its result could
  only be discarded — and the merge reschedules with fresh inputs.
- **Disk is never written**: only the buffer is updated. The file on disk changes when
  you save, as usual.
- **Every merge is journalled** to `~/.local/state/llm-save-merge/<timestamp>-<file>/`
  (base, ours, theirs, merged), and the notification offers a disk↔merged diff.
- **Fail open**: timeouts, oversized files (> `maxFileBytes`), or rejected model output
  leave the buffer untouched, so VS Code's normal conflict dialog still protects you.

## Requirements

The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed on
the machine where the extension host runs (the remote, for Remote-SSH), and an
`ANTHROPIC_API_KEY` must reach it: merges run `claude --bare`, which authenticates with
the API key only and never reads the `~/.claude` OAuth login.

**A key for the extension host, not just for your terminal.** The extension host runs
with the VS Code server's login environment. Anything an interactive shell exports on top
of that — an `ANTHROPIC_API_KEY` sourced by a shell function, say — never reaches the
`claude` child. Point `llmSaveMerge.envFile` at a dotenv file exporting the key your
shell uses (re-read on every merge), or export it in the login environment itself.

## Settings

| setting | default | meaning |
| --- | --- | --- |
| `llmSaveMerge.enabled` | `true` | auto-merge on disk divergence |
| `llmSaveMerge.model` | `claude-sonnet-5` | model id for `claude --print --bare --model` |
| `llmSaveMerge.claudePath` | `claude` | claude binary (`~/.local/bin` is added to PATH) |
| `llmSaveMerge.timeoutMs` | `240000` | merge call timeout (full-file merges of large files are output-bound and slow) |
| `llmSaveMerge.maxFileBytes` | `400000` | skip files larger than this |
| `llmSaveMerge.envFile` | `""` | dotenv file added to the claude child's environment (`~` expands; `export` prefix and quotes allowed) |

The command palette entry **LLM Save Merge: Merge disk changes into active file** runs a
merge on demand (works even with `enabled` off). For a buffer that was restored dirty
from backup — where the true ancestor is unknowable and disk divergence from before the
restore is invisible to the automatic triggers — the manual command merges anyway,
ancestor-less: the model combines buffer and disk faithfully.

## When a merge fails

Every failure shows a warning with the reason and a **Show log** button; the
**LLM Save Merge** output channel carries the full record: the spawned command line and
which credentials the child saw (names only, never values), the exit code or signal,
and both stdout and stderr. `claude --print` reports authentication errors on **stdout**
(observed on 2.1.259), so an "exited 1" with an empty stderr has its message there.

An authentication failure (`Not logged in`, `OAuth session expired`, `invalid api key`,
…) gets a dialog naming the fix — set `envFile` to a dotenv exporting
`ANTHROPIC_API_KEY` — plus an **Open settings** button, and pauses automatic merges for
10 minutes so each disk change
does not re-fail and re-prompt. The pause lifts on any `llmSaveMerge` settings change,
on the first successful merge, and never applies to the palette command.

## Tests

```sh
npm test                          # offline: mechanical merge vs git merge-file, span arithmetic, fallbacks, failure paths, stubbed CLI
npm run test:live                 # live: real claude CLI — a mechanical merge, both prompt shapes
xvfb-run -a npm run test:e2e      # e2e: real VS Code, stubbed CLI, conflict-free save
```

The offline suite includes a seeded oracle test: 300 random edit pairs merged by the
mechanical stage and by `git merge-file`, asserting the same clean/disputed verdict
on every pair and identical text on every clean one (skipped when git is absent).

The e2e run downloads a VS Code build to `.vscode-test/` on first use and drives the
real extension in a temp workspace (stub CLI, replies routed by `<file_path>`). Every
merging scenario is a genuine dispute — disk rewrites the line the buffer edited — plus
a disk-only edit the mechanical stage settles, since disjoint edits never reach the
stub. Six scenarios, one instance: the basic dirty-buffer auto-merge ending in a
conflict-free save; a corrupted excerpt reply falling back to the full-file prompt;
a clean-buffer auto-reload followed by a merge that must use the reloaded base;
an mtime-only touch that must stay quiet; the palette command merging on demand
with auto-merge disabled; and a buffer edit mid-call that must kill the call and
re-merge. On failure the suite prints every document event it saw.

## Build & install

```sh
npx --yes @vscode/vsce package --allow-missing-repository
~/.vscode-server/cli/servers/Stable-*/server/bin/code-server --install-extension llm-save-merge-*.vsix
```

Then reload the VS Code window.
