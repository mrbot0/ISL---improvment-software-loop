import fs from 'node:fs';
import path from 'node:path';
import { DENY_GLOBS, PRODUCT_DIRS, PRODUCT_WRITE_GLOBS, SECRET_GLOBS, MAX_READ_BYTES } from '../config.js';
import { matchesAny } from '../glob.js';
import { run, git } from '../sandbox/worktree.js';
import { queryIndex } from '../context/knowledgeIndex.js';

const NODE = process.execPath;

/**
 * File tools for the implementer. Unlike the proposal agents (which only *draft*
 * changes), the implementer writes directly — but always into a throwaway sandbox
 * worktree, never the real repo, so "direct write" is still safe. Every path is
 * still validated against the write scope, the global denylist and secrets.
 */

// The implementer may only touch product source + docs — in the layout the ACTIVE
// project actually has. PRODUCT_WRITE_GLOBS is a live binding (empty until a project
// is activated), so it MUST be read at call time; capturing it here once at import
// silently forbids every real edit — the implementer then "produces no edits".
export const implementerWriteGlobs = () => PRODUCT_WRITE_GLOBS;

class ToolError extends Error {}

function resolve(sandboxRoot, p, { write = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('path is required');
  const rel = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  const abs = path.resolve(sandboxRoot, rel);
  const norm = path.relative(sandboxRoot, abs).split(path.sep).join('/');
  if (norm.startsWith('..') || path.isAbsolute(norm)) throw new ToolError(`path escapes the sandbox: ${p}`);
  if (matchesAny(norm, DENY_GLOBS) || matchesAny(norm, SECRET_GLOBS)) throw new ToolError(`path is not allowed: ${norm}`);
  if (write && !matchesAny(norm, implementerWriteGlobs())) {
    throw new ToolError(`writes are restricted to ${PRODUCT_DIRS.join(', ')} — not ${norm}`);
  }
  return { abs, rel: norm };
}

export const IMPLEMENTER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file (1-indexed line numbers). Always read before editing. For a LARGE file, jump to the ' +
        'code you need instead of reading blindly: pass {find:"<symbol or text>"} to center on the first ' +
        'match, or {offset:<line>, limit:<lines>} to read a specific range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'Show a window around the first line containing this text.' },
          offset: { type: 'number', description: '1-indexed line to start from.' },
          limit: { type: 'number', description: 'How many lines to return (default 200).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or completely overwrite a file with new content. Supply the ENTIRE file. Use for new files or full rewrites.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file with a new string. The old_string must appear exactly once. Prefer this for surgical edits.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search the codebase for a string or symbol (like grep). Use it to FIND an existing helper to ' +
        'reuse instead of writing a new one, to find WHERE to wire a new function in, and to confirm a ' +
        'symbol exists before you call it. Returns matching file:line results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or symbol to search for.' },
          path: { type: 'string', description: 'Optional directory to limit the search to.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Semantic search over the WHOLE codebase and the fleet\'s learned lessons — use it to ground ' +
        'your change: describe what you need in plain words (e.g. "where booking overlap is validated", ' +
        '"how payment capture is retried") and get the most relevant files (with their key symbols) AND ' +
        'any past lesson/pitfall about that area, ranked. Better than search_code when you don\'t know ' +
        'the exact symbol. Prefer this to orient before editing an unfamiliar area.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A natural-language description of what you are looking for.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description:
        'Run the project test suite (and a parse check) against your current changes in the sandbox. ' +
        'Returns pass/fail with output. Use it after editing to prove your change works before you finish — ' +
        'if it fails, fix the code and run again.',
      parameters: {
        type: 'object',
        properties: { project: { type: 'string', enum: ['backend', 'frontend'], description: 'Which suite to run. Defaults to backend.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      /*
       * `alreadySatisfied` exists because "I made no change" and "there was nothing to change"
       * were indistinguishable, and the difference is the whole outcome of the task.
       *
       * Measured over 120 runs: of 20 tasks that ended without an edit, **11 said some variant of
       * "X already exists with 28 tests / 656 lines of coverage"** — the agent had looked, found the
       * work done, and correctly declined. Every one was recorded as a failure, so the target stayed
       * in the queue and was proposed again, and again. Inferring this from the prose would mean
       * pattern-matching English; asking for it directly does not.
       */
      description:
        'Signal this task is complete. Call once the change is made and (ideally) verified, or if you decide no safe change is possible. '
        + 'If you made NO change because the work already exists in the codebase — the test file is already there, the guard is already in place — '
        + 'set alreadySatisfied:true and name the file you found in the summary. That is a correct outcome, not a failure, and it stops the task being reissued.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          alreadySatisfied: {
            type: 'boolean',
            description: 'True when no edit was needed because the codebase already does what the task asked for.',
          },
        },
        required: ['summary'],
      },
    },
  },
];

/**
 * Build the implementer tool handlers bound to one sandbox. Tracks which files
 * were touched so the engine can report and diff them.
 * @returns {{ handlers, touched: () => string[] }}
 */
/**
 * Does this checkout use CRLF? Sampled from `.gitattributes` and a handful of real source files
 * rather than assumed from `process.platform`: a Windows machine can hold an LF repository and a
 * Linux CI can check out CRLF, so the platform is the wrong thing to ask.
 *
 * Cached per sandbox — a worktree's convention does not change while an iteration runs, and this
 * would otherwise read files on every `write_file` call.
 */
const _eolCache = new Map();
function repoUsesCrlf(root) {
  if (_eolCache.has(root)) return _eolCache.get(root);
  let crlf = false;
  try {
    const attrs = path.join(root, '.gitattributes');
    if (fs.existsSync(attrs) && /eol\s*=\s*crlf/i.test(fs.readFileSync(attrs, 'utf8'))) {
      crlf = true;
    } else {
      // Sample real files: whichever ending dominates the code is the one a new file should use.
      let seenCrlf = 0;
      let seenLf = 0;
      for (const dir of PRODUCT_DIRS.length ? PRODUCT_DIRS : ['.']) {
        const base = path.join(root, dir);
        if (!fs.existsSync(base)) continue;
        for (const f of sampleSourceFiles(base, 5)) {
          const s = fs.readFileSync(f, 'utf8');
          seenCrlf += (s.match(/\r\n/g) || []).length;
          seenLf += (s.match(/(?<!\r)\n/g) || []).length;
        }
      }
      crlf = seenCrlf > seenLf;
    }
  } catch {
    crlf = false; // unreadable — LF is the safer default; it is what git stores.
  }
  _eolCache.set(root, crlf);
  return crlf;
}

/** A few source files from a directory tree, for sniffing conventions. Bounded, never recursive-deep. */
function sampleSourceFiles(dir, want, depth = 0, out = []) {
  if (out.length >= want || depth > 3) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= want) break;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sampleSourceFiles(full, want, depth + 1, out);
    else if (/\.(js|jsx|ts|tsx|py|go|rb|java|php|cs)$/.test(e.name)) out.push(full);
  }
  return out;
}

export function makeImplementerTools(sandboxRoot) {
  const touched = new Set();
  const created = new Set(); // files this task created from scratch (dead-code risk)

  const handlers = {
    search_code({ query, path: scope }) {
      if (typeof query !== 'string' || !query.trim()) return 'query is required';
      const dirs = scope ? [scope.replace(/\\/g, '/').replace(/^\.?\//, '')] : PRODUCT_DIRS;
      try {
        const out = git(['grep', '-nI', '--untracked', '-e', query, '--', ...dirs], sandboxRoot);
        const lines = out.split('\n').filter(Boolean);
        if (!lines.length) return `No matches for "${query}".`;
        const shown = lines.slice(0, 40).join('\n');
        return `${lines.length} match(es) for "${query}"${lines.length > 40 ? ' (showing 40)' : ''}:\n${shown}`;
      } catch {
        return `No matches for "${query}".`; // git grep exits non-zero when nothing matches
      }
    },

    async search_knowledge({ query }) {
      if (typeof query !== 'string' || !query.trim()) return 'query is required';
      try {
        const { results, mode } = await queryIndex(query, { k: 8 });
        if (!results?.length) return `No knowledge matches for "${query}".`;
        const lines = results.map((r) => {
          const tag = r.kind === 'memory' ? 'lesson' : r.kind === 'change' ? 'past change' : 'code';
          const extra = r.kind === 'memory'
            ? ` — ${r.snippet}`
            : r.kind === 'change'
              ? ` (${r.sha}, score ${r.changeScore ?? '—'})`
              : (r.symbols?.length ? ` {${r.symbols.slice(0, 6).join(', ')}}` : '');
          return `- [${tag}] ${r.title}${extra}`;
        });
        return `Top matches for "${query}" (${mode}):\n${lines.join('\n')}\n` +
          `Read the most relevant file with read_file before editing.`;
      } catch (e) {
        return `Knowledge search unavailable (${e.message}). Fall back to search_code.`;
      }
    },

    read_file({ path: p, find = null, offset = null, limit = null }) {
      const { abs, rel } = resolve(sandboxRoot, p);
      if (!fs.existsSync(abs)) return `File does not exist: ${rel}`;
      const raw = fs.readFileSync(abs, 'utf8');
      const lines = raw.split('\n');
      const number = (arr, from) => arr.map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`).join('\n');

      // {find}: jump to the first match — the way to locate code in a 200KB file.
      if (find && String(find).trim()) {
        const needle = String(find);
        const idx = lines.findIndex((l) => l.includes(needle));
        if (idx < 0) return `"${needle}" not found in ${rel} (${lines.length} lines). Try a different symbol.`;
        const from = Math.max(0, idx - 12);
        const to = Math.min(lines.length, idx + 120);
        return `=== ${rel} (lines ${from + 1}-${to}, around "${needle}") ===\n` + number(lines.slice(from, to), from);
      }

      // {offset,limit}: read a specific range without pulling the whole file.
      if (offset != null || limit != null) {
        const from = Math.max(0, (Number(offset) || 1) - 1);
        const to = Math.min(lines.length, from + (Number(limit) || 200));
        return `=== ${rel} (lines ${from + 1}-${to} of ${lines.length}) ===\n` + number(lines.slice(from, to), from);
      }

      // Whole file, but capped — and now we say so explicitly and tell the model how to see the rest.
      if (raw.length > MAX_READ_BYTES) {
        const shown = raw.slice(0, MAX_READ_BYTES).split('\n');
        return (
          `=== ${rel} (first ${shown.length} lines of ${lines.length} — file is ${Math.round(raw.length / 1000)}KB. ` +
          `Use read_file {find:"<symbol>"} or {offset,limit} to see the rest) ===\n` +
          number(shown, 0)
        );
      }
      return `=== ${rel} ===\n` + number(lines, 0);
    },

    write_file({ path: p, content }) {
      if (typeof content !== 'string') return 'content must be a string';
      const { abs, rel } = resolve(sandboxRoot, p, { write: true });
      const existed = fs.existsSync(abs);
      // The same CRLF trap as `edit_file`, in the other direction: a model emits `\n`, and rewriting
      // a CRLF file with it changes EVERY line. The diff then claims the whole file was rewritten —
      // which trips the change-size budget, drowns the real edit in review, and makes an honest
      // three-line change indistinguishable from a rewrite.
      let out = content;
      if (existed) {
        const old = fs.readFileSync(abs, 'utf8');
        if (old.length > 200 && content.length < old.length * 0.4)
          return `Rejected: new content for ${rel} is <40% of the original — you are likely truncating it. Read it and supply the complete file.`;
        const crlf = (old.match(/\r\n/g) || []).length;
        const lf = (old.match(/(?<!\r)\n/g) || []).length;
        if (crlf > lf) out = content.replace(/\r?\n/g, '\r\n');
      } else {
        // A NEW file follows the repository's prevailing convention rather than the model's, so it
        // does not stand out as the one file with different endings.
        out = repoUsesCrlf(sandboxRoot) ? content.replace(/\r?\n/g, '\r\n') : content.replace(/\r\n/g, '\n');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, out, 'utf8');
      touched.add(rel);
      if (!existed) created.add(rel);
      return `${existed ? 'Overwrote' : 'Created'} ${rel} (${content.split('\n').length} lines).`;
    },

    edit_file({ path: p, old_string, new_string }) {
      const { abs, rel } = resolve(sandboxRoot, p, { write: true });
      if (!fs.existsSync(abs)) return `File does not exist: ${rel}`;
      if (typeof old_string !== 'string' || !old_string) return 'old_string is required';
      const src = fs.readFileSync(abs, 'utf8');

      /*
       * LINE ENDINGS ARE NOT PART OF THE MATCH.
       *
       * This was the single largest failure in the whole system: 103 tasks ended with "the
       * implementer finished without editing any file". The cause was not the model's reasoning —
       * it was `\r\n`.
       *
       * On Windows with `core.autocrlf=true` (git's default there, and what this repository is
       * checked out with) every source file is 100% CRLF. A language model reading that file and
       * quoting a few lines back emits `\n`, as models do. `src.split(old_string)` then found ZERO
       * matches, the tool answered "copy the exact text", the model copied it again, produced `\n`
       * again, and after three nudges the task gave up having changed nothing.
       *
       * On Linux or macOS the same code works perfectly — which is exactly why it survived: it is a
       * defect you cannot see unless you run on the platform that has it.
       *
       * The match is therefore made line-ending-agnostic, but the WRITE is not: the replacement is
       * applied to the original text and only `new_string`'s own endings are converted to the file's
       * convention. Every untouched byte stays as it was — normalising the whole file would turn a
       * three-line edit into a diff that claims every line changed, blow the change budget, and read
       * as a rewrite in review.
       */
      const eolAgnostic = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n');
      let re;
      try {
        re = new RegExp(eolAgnostic(old_string), 'g');
      } catch {
        return `old_string could not be matched in ${rel} — it contains something unrepresentable.`;
      }
      const matches = src.match(re);
      const count = matches ? matches.length : 0;
      if (count === 0) return `old_string not found in ${rel}. Read the file and copy the exact text.`;
      if (count > 1) return `old_string appears ${count} times in ${rel} — make it unique with more surrounding context.`;

      // Match the file's own convention so the diff shows only what actually changed.
      const crlf = (src.match(/\r\n/g) || []).length;
      const lf = (src.match(/(?<!\r)\n/g) || []).length;
      const replacement = String(new_string ?? '').replace(/\r?\n/g, crlf > lf ? '\r\n' : '\n');

      // `$` is meaningful in a replacement string; the callback form takes the text literally.
      fs.writeFileSync(abs, src.replace(re, () => replacement), 'utf8');
      touched.add(rel);
      return `Edited ${rel}.`;
    },

    async run_tests({ project = 'backend' } = {}) {
      const proj = project === 'frontend' ? 'frontend' : 'backend';
      const cwd = path.join(sandboxRoot, proj);
      // Parse-check the touched files of this project first (fast, catches syntax errors).
      for (const rel of touched) {
        if (!rel.startsWith(proj + '/') || !/\.(js|mjs|cjs)$/.test(rel)) continue;
        const { exitCode, output } = await run(NODE, ['--check', path.join(sandboxRoot, rel)], { cwd: sandboxRoot, timeoutMs: 15000 });
        if (exitCode !== 0) return `✕ PARSE ERROR in ${rel}:\n${output.split('\n').slice(0, 4).join('\n')}\nFix it before running tests.`;
      }
      const vitest = path.join(cwd, 'node_modules/vitest/vitest.mjs');
      if (!fs.existsSync(vitest)) return `The ${proj} project has no vitest installed — parse check passed, but no test suite to run.`;
      const { exitCode, output, ms } = await run(NODE, [vitest, 'run'], { cwd, timeoutMs: 300000 });
      if (exitCode === 0) return `✓ ${proj} tests PASS (${ms}ms). Your change is verified — call finish().`;
      return `✕ ${proj} tests FAIL (exit ${exitCode}). Fix the code and run_tests again.\n\n--- output (tail) ---\n${(output || '').slice(-2500)}`;
    },

    finish({ summary, alreadySatisfied }) {
      // The marker carries the flag so the caller can tell "nothing needed doing" from "I could not
      // do it" — two outcomes that look identical in a diff and mean opposite things for the queue.
      return `__FINISH__${alreadySatisfied ? '__SATISFIED__' : ''}${summary || 'done'}`;
    },
  };

  return { handlers, touched: () => [...touched], created: () => [...created] };
}

export { ToolError };
