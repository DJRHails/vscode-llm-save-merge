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

function runClaude({ claudePath, model, timeoutMs, instruction, payload, cancellation }) {
  return new Promise((resolve, reject) => {
    if (cancellation?.isCancellationRequested) return reject(cancellationError());
    const env = { ...process.env };
    env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:${env.PATH ?? ''}`;
    const args = ['--print', '--model', model, '--output-format', 'text', instruction];
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
    child.on('close', (code) => {
      clearTimeout(timer);
      cancelSub?.dispose?.();
      if (cancelled) return reject(cancellationError());
      if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs}ms`));
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
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
  });
  const merged = normalizeTrailingNewline(stripWrappingFence(raw), ours, theirs);
  const problem = validateMerged(merged, ours, theirs);
  if (problem) {
    throw new Error(`rejected merge output for ${path.basename(filePath)}: ${problem}`);
  }
  return merged;
}

async function llmMerge(opts) {
  const { base, ours, theirs } = opts;
  const log = opts.log ?? (() => {});
  // One side unchanged relative to the ancestor: the other side IS the merge.
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  const plan = buildExcerptPlan(opts);
  if (plan) {
    const pct = Math.round(((plan.end - plan.start + 1) / plan.baseCount) * 100);
    log(`excerpt merge: lines ${plan.start}-${plan.end} of ${plan.baseCount} (${pct}%)`);
    try {
      return await mergeViaExcerpt(opts, plan);
    } catch (err) {
      if (err.cancelled) throw err; // a user cancel must not trigger a second model call
      log(`excerpt merge failed (${err.message}); retrying with the full file`);
    }
  }
  return mergeViaFullFile(opts);
}

module.exports = {
  llmMerge,
  buildPayload,
  buildExcerptPlan,
  buildExcerptPayload,
  splitLines,
  joinLines,
  spliceSegment,
  stripWrappingFence,
  normalizeTrailingNewline,
};
