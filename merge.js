// CommonJS: the VS Code extension host requires a CJS entry point for extensions.
'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const Diff = require('diff');

const DIFF_CONTEXT = 3; // context lines inside each unified-diff hunk
const SPAN_PAD = 3; // unchanged base lines kept around the changed span, beyond hunk context
const SPAN_MAX_RATIO = 0.8; // above this fraction of the file, excerpt mode buys nothing

// Every block the payload can carry, for leak detection in validateMerged.
const PAYLOAD_TAGS = [
  '<base>',
  '</base>',
  '<ours>',
  '</ours>',
  '<theirs>',
  '</theirs>',
  '<original_excerpt>',
  '</original_excerpt>',
  '<diff_original_to_ours>',
  '</diff_original_to_ours>',
  '<diff_original_to_theirs>',
  '</diff_original_to_theirs>',
];

const FULL_FILE_INSTRUCTION = [
  'Perform a three-way merge of a text file. The piped input contains three versions of',
  'the same file in XML tags: <base> (the common ancestor both sides started from),',
  "<ours> (the user's unsaved editor buffer), and <theirs> (the file on disk, modified",
  'by another process).',
  '',
  'Apply BOTH sets of changes relative to <base>. Where the two sides changed the same',
  'region in incompatible ways, prefer <ours>, but never drop <theirs>-only additions',
  'or changes elsewhere in the file. If <base> is empty because the ancestor is',
  'unknown, produce the best faithful combination of <ours> and <theirs>. Preserve',
  'formatting, whitespace, and blank lines exactly as they appear in the inputs.',
  '',
  'Do not use any tools. Output ONLY the complete merged file content: no XML tags, no',
  'code fences, no commentary, nothing before or after it.',
].join('\n');

const EXCERPT_INSTRUCTION = [
  'Perform a three-way merge on an excerpt of a text file. The piped input contains,',
  'in XML tags: <original_excerpt> (a contiguous slice of the original file that',
  'covers every change, plus a few unchanged context lines at each edge), then two',
  'unified diffs against the same original file: <diff_original_to_ours> (to the',
  "user's unsaved editor buffer) and <diff_original_to_theirs> (to the file on disk,",
  'modified by another process). Hunk headers refer to original-file line numbers;',
  '<excerpt_range> states which original lines the excerpt spans.',
  '',
  'Apply BOTH diffs to the excerpt. Where the two sides changed the same region in',
  'incompatible ways, prefer ours, but never drop theirs-only additions or changes.',
  "Lines neither diff touches — in particular the excerpt's leading and trailing",
  'context lines — must be reproduced verbatim. Preserve formatting, whitespace, and',
  'blank lines exactly as they appear in the inputs.',
  '',
  'Do not use any tools. Output ONLY the merged excerpt, the full replacement for the',
  'content of <original_excerpt>: no XML tags, no code fences, no commentary, nothing',
  'before or after it.',
].join('\n');

function splitLines(text) {
  const lines = text.split('\n');
  const trailingNewline = text.endsWith('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinLines(lines, trailingNewline) {
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

// Replace base lines start..end (1-indexed, inclusive) with the given segment.
function spliceSegment(baseLines, start, end, segmentLines) {
  return [...baseLines.slice(0, start - 1), ...segmentLines, ...baseLines.slice(end)];
}

// The base-line range touched by a patch, hunk context included. 1-indexed, inclusive.
function changedSpan(hunks) {
  let start = Infinity;
  let end = -Infinity;
  for (const hunk of hunks) {
    start = Math.min(start, hunk.oldStart);
    end = Math.max(end, hunk.oldStart + Math.max(hunk.oldLines, 1) - 1);
  }
  return { start, end };
}

// A side's lines corresponding to base lines start..end. Every hunk of the side's diff
// lies inside the span, so lines before the span keep their indices and the segment
// only stretches or shrinks at its far end, by the side's total line-count delta.
function sideSegment(sideLines, start, end, baseCount) {
  return sideLines.slice(start - 1, end + sideLines.length - baseCount);
}

// Everything needed to merge via excerpt + diffs, or null when excerpt mode does not
// apply (unknown ancestor, or the changed span covers most of the file).
function buildExcerptPlan({ base, ours, theirs, filePath }) {
  if (!base) return null; // ancestor unknown; only the full-file prompt handles that
  const baseSplit = splitLines(base);
  const baseCount = baseSplit.lines.length;
  const name = path.basename(filePath);
  const oursPatch = Diff.structuredPatch(name, name, base, ours, 'original', 'ours', {
    context: DIFF_CONTEXT,
  });
  const theirsPatch = Diff.structuredPatch(name, name, base, theirs, 'original', 'theirs', {
    context: DIFF_CONTEXT,
  });
  if (!oursPatch.hunks.length || !theirsPatch.hunks.length) return null;

  const oursSpan = changedSpan(oursPatch.hunks);
  const theirsSpan = changedSpan(theirsPatch.hunks);
  const hunksStart = Math.min(oursSpan.start, theirsSpan.start);
  const hunksEnd = Math.max(oursSpan.end, theirsSpan.end);
  const start = Math.max(1, hunksStart - SPAN_PAD);
  const end = Math.min(baseCount, hunksEnd + SPAN_PAD);
  if ((end - start + 1) / baseCount > SPAN_MAX_RATIO) return null;

  const oursSplit = splitLines(ours);
  const theirsSplit = splitLines(theirs);
  const oursSegment = sideSegment(oursSplit.lines, start, end, baseCount);
  const theirsSegment = sideSegment(theirsSplit.lines, start, end, baseCount);
  // Runtime invariant: splicing a side's own segment back into base must reproduce
  // that side byte-for-byte. If not, the span arithmetic is wrong for this input —
  // fall back to the full-file prompt rather than risk a corrupting splice.
  const oursRebuilt = joinLines(
    spliceSegment(baseSplit.lines, start, end, oursSegment),
    oursSplit.trailingNewline
  );
  const theirsRebuilt = joinLines(
    spliceSegment(baseSplit.lines, start, end, theirsSegment),
    theirsSplit.trailingNewline
  );
  if (oursRebuilt !== ours || theirsRebuilt !== theirs) return null;

  return {
    start,
    end,
    baseCount,
    baseLines: baseSplit.lines,
    baseTrailingNewline: baseSplit.trailingNewline,
    baseSegment: baseSplit.lines.slice(start - 1, end),
    oursSegment,
    theirsSegment,
    leadAnchor: hunksStart - start, // excerpt edge lines no hunk touches
    trailAnchor: end - hunksEnd,
    oursDiff: Diff.formatPatch(oursPatch),
    theirsDiff: Diff.formatPatch(theirsPatch),
  };
}

// --- Mechanical merge -----------------------------------------------------------------
// Most divergences are the two sides editing different parts of the file, which a
// diff3-style merge settles exactly and instantly. A model call is reserved for hunks
// the sides genuinely dispute — and even then the model sees only those.

// One side's edits as context-free hunks against the base, so each hunk's old range is
// exactly the base lines it replaces. A pure insertion has oldLines 0 and oldStart naming
// the base line it goes in front of (jsdiff's convention; GNU diff names the line after
// which it goes). Both texts get a trailing newline first, or jsdiff reports a missing
// one as a change to the last line; the trailing newline merges on its own.
function changeHunks(base, side) {
  const withNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);
  return Diff.structuredPatch('', '', withNewline(base), withNewline(side), '', '', {
    context: 0,
  }).hunks;
}

// The base-line boundaries a hunk touches, boundary b lying between lines b and b+1: a
// replacement of lines s..e touches s-1..e, an insertion in front of line k touches k-1.
// Hunks from the two sides conflict when they touch a common boundary — diff3's rule that
// edits with no unchanged line between them have no mechanical ordering.
function touchedBoundaries(hunk) {
  return { lo: hunk.oldStart - 1, hi: hunk.oldStart + hunk.oldLines - 1 };
}

function hunksConflict(a, b) {
  const x = touchedBoundaries(a);
  const y = touchedBoundaries(b);
  return x.lo <= y.hi && y.lo <= x.hi;
}

function sameHunk(a, b) {
  return (
    a.oldStart === b.oldStart &&
    a.oldLines === b.oldLines &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

// Apply pairwise non-conflicting hunks to the base lines.
function applyHunks(baseLines, hunks) {
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const pieces = [];
  let cursor = 0; // base lines before this index are already placed
  for (const hunk of ordered) {
    const from = hunk.oldStart - 1;
    pieces.push(baseLines.slice(cursor, from));
    pieces.push(hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)));
    cursor = from + hunk.oldLines;
  }
  pieces.push(baseLines.slice(cursor));
  return pieces.flat();
}

// Split both sides' hunks into those a mechanical merge can apply — touching no hunk of
// the other side, or identical to the one they touch — and the disputed remainder.
function partitionHunks(oursHunks, theirsHunks) {
  const settled = [];
  const oursDisputed = [];
  const theirsDisputed = [];
  const duplicated = new Set(); // theirs hunks identical to an ours hunk: applied once
  for (const ours of oursHunks) {
    const rivals = theirsHunks.filter((theirs) => hunksConflict(ours, theirs));
    const identical = rivals.length === 1 && sameHunk(ours, rivals[0]);
    if (identical) duplicated.add(rivals[0]);
    if (rivals.length === 0 || identical) settled.push(ours);
    else oursDisputed.push(ours);
  }
  for (const theirs of theirsHunks) {
    if (duplicated.has(theirs)) continue;
    if (oursHunks.some((ours) => hunksConflict(ours, theirs))) theirsDisputed.push(theirs);
    else settled.push(theirs);
  }
  return { settled, oursDisputed, theirsDisputed };
}

// Three-way merge of the trailing newline, a change the line hunks never see.
function mergedTrailingNewline(base, ours, theirs) {
  const baseHas = base.endsWith('\n');
  const oursHas = ours.endsWith('\n');
  return oursHas !== baseHas ? oursHas : theirs.endsWith('\n');
}

// Everything the sides do not dispute, applied without a model. Returns the finished
// merge when the sides touch disjoint regions; otherwise the three versions with every
// settled hunk applied to all of them, so a model sees only the disputed hunks. Null when
// a side's own hunks do not rebuild that side — the hunk arithmetic does not hold for
// this input, and the whole diff goes to the model instead.
function mechanicalMerge({ base, ours, theirs }) {
  const baseLines = splitLines(base).lines;
  const oursHunks = changeHunks(base, ours);
  const theirsHunks = changeHunks(base, theirs);
  const rebuilds = (hunks, side) =>
    joinLines(applyHunks(baseLines, hunks), side.endsWith('\n')) === side;
  if (!rebuilds(oursHunks, ours) || !rebuilds(theirsHunks, theirs)) return null;

  const { settled, oursDisputed, theirsDisputed } = partitionHunks(oursHunks, theirsHunks);
  const disputed = oursDisputed.length + theirsDisputed.length;
  if (disputed === 0) {
    const lines = applyHunks(baseLines, settled);
    const merged = joinLines(lines, mergedTrailingNewline(base, ours, theirs));
    return { merged, settled: settled.length, disputed };
  }
  return {
    settled: settled.length,
    disputed,
    base: joinLines(applyHunks(baseLines, settled), base.endsWith('\n')),
    ours: joinLines(applyHunks(baseLines, [...settled, ...oursDisputed]), ours.endsWith('\n')),
    theirs: joinLines(
      applyHunks(baseLines, [...settled, ...theirsDisputed]),
      theirs.endsWith('\n')
    ),
  };
}

function xmlBlock(tag, content) {
  return `<${tag}>\n${content}\n</${tag}>`;
}

function buildExcerptPayload(plan, filePath) {
  return [
    `<file_path>${filePath}</file_path>`,
    `<excerpt_range>lines ${plan.start}-${plan.end} of ${plan.baseCount}</excerpt_range>`,
    xmlBlock('original_excerpt', plan.baseSegment.join('\n')),
    xmlBlock('diff_original_to_ours', plan.oursDiff),
    xmlBlock('diff_original_to_theirs', plan.theirsDiff),
  ].join('\n');
}

function buildPayload(base, ours, theirs, filePath) {
  return [
    `<file_path>${filePath}</file_path>`,
    xmlBlock('base', base),
    xmlBlock('ours', ours),
    xmlBlock('theirs', theirs),
  ].join('\n');
}

function stripWrappingFence(text) {
  const fenced = text.match(
    /^```[^\n]*\n([\s\S]*?)\n```\s*$/ // a single fence wrapping the whole output
  );
  return fenced ? `${fenced[1]}\n` : text;
}

function normalizeTrailingNewline(merged, ours, theirs) {
  const oursNl = ours.endsWith('\n');
  const theirsNl = theirs.endsWith('\n');
  if (oursNl && theirsNl) {
    const blankAtEof = ours.endsWith('\n\n') || theirs.endsWith('\n\n');
    if (blankAtEof) return merged.endsWith('\n') ? merged : `${merged}\n`;
    return `${merged.replace(/\n+$/, '')}\n`;
  }
  if (!oursNl && !theirsNl && merged.endsWith('\n')) return merged.replace(/\n+$/, '');
  return merged;
}

function validateMerged(merged, ours, theirs) {
  if (merged.trim().length === 0) return 'model returned empty output';
  // A payload tag in the output that neither input carries means the model echoed
  // prompt structure instead of file content (files legitimately containing these
  // strings — this repo's own source, say — pass, because the inputs carry them too).
  const leaked = PAYLOAD_TAGS.find(
    (tag) => merged.includes(tag) && !ours.includes(tag) && !theirs.includes(tag)
  );
  if (leaked) return `payload tag ${leaked} leaked into output`;
  const hasConflictMarkers =
    /^(<{7}|={7}|>{7})/m.test(merged) && !/^(<{7}|={7}|>{7})/m.test(ours + theirs);
  if (hasConflictMarkers) return 'model emitted conflict markers';
  const floor = Math.min(ours.length, theirs.length) * 0.5;
  if (merged.length < floor) return 'merged output suspiciously short';
  return null;
}

// The excerpt's edge lines are outside every hunk of both diffs, so no correct merge
// may change them. A violated anchor means the model lost alignment.
function validateExcerptAnchors(mergedLines, plan) {
  for (let i = 0; i < plan.leadAnchor; i += 1) {
    if (mergedLines[i] !== plan.baseSegment[i]) {
      return `leading context line ${i + 1} not reproduced verbatim`;
    }
  }
  for (let i = 0; i < plan.trailAnchor; i += 1) {
    const merged = mergedLines[mergedLines.length - 1 - i];
    const original = plan.baseSegment[plan.baseSegment.length - 1 - i];
    if (merged !== original) {
      return `trailing context line ${i + 1} (from the end) not reproduced verbatim`;
    }
  }
  return null;
}

// `cancellation` is duck-typed to VS Code's CancellationToken so this module stays
// free of the vscode import: { isCancellationRequested, onCancellationRequested }.
function cancellationError() {
  const err = new Error('merge cancelled by user');
  err.cancelled = true;
  return err;
}

// Auth failures the CLI reports in --print mode. They arrive on STDOUT with exit 1 and
// an empty stderr (observed on claude 2.1.259):
//   "Failed to authenticate: OAuth session expired and could not be refreshed"
//   "Not logged in · Please run /login"
const AUTH_FAILURE_PATTERN =
  /not logged in|failed to authenticate|oauth session expired|please run \/login|invalid api key|authentication_error/i;

// Parse a dotenv file: KEY=VALUE lines, an optional `export ` prefix, single or double
// quotes around the value (which protect a `#`), and ` #` comments after bare values.
function parseDotenv(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const quoted = match[2].match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
    env[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '').trim();
  }
  return env;
}

// What the child will authenticate with, for the log and the failure dialog. Names
// only — never a value.
function describeAuthSources(env, extraEnv) {
  let key = 'no ANTHROPIC_API_KEY';
  if (extraEnv.ANTHROPIC_API_KEY) key = 'ANTHROPIC_API_KEY from envFile';
  else if (env.ANTHROPIC_API_KEY) key = 'ANTHROPIC_API_KEY from the host environment';
  const configDir = env.CLAUDE_CONFIG_DIR ?? '~/.claude (default)';
  return `${key}; CLAUDE_CONFIG_DIR ${configDir}`;
}

function tailForMessage(text, maxChars) {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

// The CLI puts auth and API errors on stdout in --print mode, so an empty stderr says
// nothing on its own: fall back to the tail of stdout, where the error lands.
function claudeFailure({ code, signal, stdout, stderr, authSources }) {
  const exit = signal ? `was killed by ${signal}` : `exited ${code}`;
  const detail =
    tailForMessage(stderr, 400) ||
    tailForMessage(stdout, 400) ||
    '(no output on stdout or stderr)';
  const err = new Error(`claude ${exit}: ${detail}`);
  err.detail = detail;
  err.exitCode = code;
  err.signal = signal;
  err.stdout = stdout;
  err.stderr = stderr;
  err.auth = AUTH_FAILURE_PATTERN.test(detail);
  err.authSources = authSources;
  return err;
}

function runClaude({
  claudePath,
  model,
  timeoutMs,
  instruction,
  payload,
  cancellation,
  extraEnv = {},
  log = () => {},
}) {
  return new Promise((resolve, reject) => {
    if (cancellation?.isCancellationRequested) return reject(cancellationError());
    const env = { ...process.env, ...extraEnv };
    env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:${env.PATH ?? ''}`;
    const authSources = describeAuthSources(env, extraEnv);
    // Bare mode: no hooks, plugins, MCP servers, LSPs, CLAUDE.md, or session files. A
    // merge needs none of them, and together they cost ~13s and a 54k-token system prompt
    // per call (measured 2026-09-03 on 2.1.259). Bare mode authenticates with
    // ANTHROPIC_API_KEY only; the ~/.claude OAuth login is never read.
    const args = [
      '--print',
      '--bare',
      '--model',
      model,
      '--output-format',
      'text',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      instruction,
    ];
    log(
      `spawning ${claudePath} --print --bare --model ${model} ` +
        `(no tools, no MCP; cwd ${os.tmpdir()}; ${authSources})`
    );
    const child = spawn(claudePath, args, {
      cwd: os.tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const killChild = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    const cancelSub = cancellation?.onCancellationRequested?.(() => {
      cancelled = true;
      killChild();
    });

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      cancelSub?.dispose?.();
      reject(new Error(`failed to spawn ${claudePath}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      cancelSub?.dispose?.();
      if (cancelled) return reject(cancellationError());
      if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs}ms`));
      if (code !== 0) {
        return reject(claudeFailure({ code, signal, stdout, stderr, authSources }));
      }
      resolve(stdout);
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

async function mergeViaExcerpt(opts, plan) {
  const raw = await runClaude({
    claudePath: opts.claudePath,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    instruction: EXCERPT_INSTRUCTION,
    payload: buildExcerptPayload(plan, opts.filePath),
    cancellation: opts.cancellation,
    extraEnv: opts.extraEnv,
    log: opts.log,
  });
  const mergedSegment = splitLines(stripWrappingFence(raw)).lines;
  const problem =
    validateMerged(
      mergedSegment.join('\n'),
      plan.oursSegment.join('\n'),
      plan.theirsSegment.join('\n')
    ) ?? validateExcerptAnchors(mergedSegment, plan);
  if (problem) throw new Error(problem);
  const fullLines = spliceSegment(plan.baseLines, plan.start, plan.end, mergedSegment);
  const merged = joinLines(fullLines, plan.baseTrailingNewline);
  return normalizeTrailingNewline(merged, opts.ours, opts.theirs);
}

async function mergeViaFullFile(opts) {
  const { base, ours, theirs, filePath, model, claudePath, timeoutMs, cancellation } = opts;
  const payload = buildPayload(base, ours, theirs, filePath);
  const raw = await runClaude({
    claudePath,
    model,
    timeoutMs,
    instruction: FULL_FILE_INSTRUCTION,
    payload,
    cancellation,
    extraEnv: opts.extraEnv,
    log: opts.log,
  });
  const merged = normalizeTrailingNewline(stripWrappingFence(raw), ours, theirs);
  const problem = validateMerged(merged, ours, theirs);
  if (problem) {
    throw new Error(`rejected merge output for ${path.basename(filePath)}: ${problem}`);
  }
  return merged;
}

function staleError() {
  const err = new Error('inputs went stale during the merge');
  err.stale = true;
  return err;
}

// The mechanical stage's verdict: the finished merge when nothing is disputed, otherwise
// the inputs the model should see.
function settleMechanically(opts, log) {
  const { base, ours, theirs } = opts;
  const outcome = base ? mechanicalMerge({ base, ours, theirs }) : null;
  if (!outcome) {
    if (base) log('hunk arithmetic does not hold for this input; the whole diff goes to the model');
    return { inputs: opts };
  }
  if (outcome.disputed === 0) {
    log(`merged mechanically: ${outcome.settled} hunks, none disputed; no model call`);
    return { merged: outcome.merged };
  }
  log(
    `mechanical stage settled ${outcome.settled} hunks; ` +
      `${outcome.disputed} disputed hunks go to the model`
  );
  return { inputs: { ...opts, base: outcome.base, ours: outcome.ours, theirs: outcome.theirs } };
}

async function llmMerge(opts) {
  const { base, ours, theirs } = opts;
  const log = opts.log ?? (() => {});
  // One side unchanged relative to the ancestor: the other side IS the merge.
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  const { merged, inputs } = settleMechanically(opts, log);
  if (merged !== undefined) return merged;

  const plan = buildExcerptPlan(inputs);
  if (plan) {
    const pct = Math.round(((plan.end - plan.start + 1) / plan.baseCount) * 100);
    log(`excerpt merge: lines ${plan.start}-${plan.end} of ${plan.baseCount} (${pct}%)`);
    try {
      return await mergeViaExcerpt(inputs, plan);
    } catch (err) {
      if (err.cancelled) throw err; // a user cancel must not trigger a second model call
      // A slow excerpt call (minutes under API degradation) leaves time for the
      // buffer or disk to move on; a full-file call on stale inputs is pre-doomed
      // and would burn the whole timeout again. Bail out to the caller's retry.
      if (opts.isStale && (await opts.isStale())) {
        log(`excerpt merge failed (${err.message}); inputs stale, skipping the full-file retry`);
        throw staleError();
      }
      log(`excerpt merge failed (${err.message}); retrying with the full file`);
    }
  }
  return mergeViaFullFile(inputs);
}

module.exports = {
  llmMerge,
  mechanicalMerge,
  parseDotenv,
  buildPayload,
  buildExcerptPlan,
  buildExcerptPayload,
  splitLines,
  joinLines,
  spliceSegment,
  stripWrappingFence,
  normalizeTrailingNewline,
};
