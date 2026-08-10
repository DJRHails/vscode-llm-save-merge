// CommonJS: the VS Code extension host requires a CJS entry point for extensions.
'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const SENTINEL_BASE = '-----8<----- LLM-SAVE-MERGE SECTION: BASE -----8<-----';
const SENTINEL_OURS =
  '-----8<----- LLM-SAVE-MERGE SECTION: OURS (unsaved editor buffer) -----8<-----';
const SENTINEL_THEIRS =
  '-----8<----- LLM-SAVE-MERGE SECTION: THEIRS (file on disk) -----8<-----';
const SENTINEL_END = '-----8<----- LLM-SAVE-MERGE SECTION: END -----8<-----';

const INSTRUCTION = [
  'Perform a three-way merge of a text file. The piped input contains three versions of',
  'the same file, delimited by sentinel lines: BASE (the common ancestor both sides',
  "started from), OURS (the user's unsaved editor buffer), and THEIRS (the file on disk,",
  'modified by another process).',
  '',
  'Apply BOTH sets of changes relative to BASE. Where the two sides changed the same',
  'region in incompatible ways, prefer OURS, but never drop THEIRS-only additions or',
  'changes elsewhere in the file. If BASE is empty because the ancestor is unknown,',
  'produce the best faithful combination of OURS and THEIRS. Preserve formatting,',
  'whitespace, and blank lines exactly as they appear in the inputs.',
  '',
  'Do not use any tools. Output ONLY the complete merged file content: no code fences,',
  'no commentary, nothing before or after it.',
].join('\n');

function buildPayload(base, ours, theirs, filePath) {
  return [
    `File path: ${filePath}`,
    SENTINEL_BASE,
    base,
    SENTINEL_OURS,
    ours,
    SENTINEL_THEIRS,
    theirs,
    SENTINEL_END,
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
  if (merged.includes('LLM-SAVE-MERGE SECTION')) return 'sentinel lines leaked into output';
  const hasConflictMarkers =
    /^(<{7}|={7}|>{7})/m.test(merged) && !/^(<{7}|={7}|>{7})/m.test(ours + theirs);
  if (hasConflictMarkers) return 'model emitted conflict markers';
  const floor = Math.min(ours.length, theirs.length) * 0.5;
  if (merged.length < floor) return 'merged output suspiciously short';
  return null;
}

function runClaude({ claudePath, model, timeoutMs, payload }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:${env.PATH ?? ''}`;
    const args = ['--print', '--model', model, '--output-format', 'text', INSTRUCTION];
    const child = spawn(claudePath, args, {
      cwd: os.tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${claudePath}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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

async function llmMerge({ base, ours, theirs, filePath, model, claudePath, timeoutMs }) {
  const payload = buildPayload(base, ours, theirs, filePath);
  const raw = await runClaude({ claudePath, model, timeoutMs, payload });
  const merged = normalizeTrailingNewline(stripWrappingFence(raw), ours, theirs);
  const problem = validateMerged(merged, ours, theirs);
  if (problem) {
    throw new Error(`rejected merge output for ${path.basename(filePath)}: ${problem}`);
  }
  return merged;
}

module.exports = { llmMerge, buildPayload, stripWrappingFence, normalizeTrailingNewline };
