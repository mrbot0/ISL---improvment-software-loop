import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { DENY_GLOBS, MAX_READ_BYTES, REPO_ROOT, SECRET_GLOBS } from '../config.js';
import { matchesAny } from '../glob.js';

/** Repo-relative, forward-slashed. The only path format tools ever speak. */
const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

class ToolError extends Error {}

/**
 * Resolve an agent-supplied path and prove it is safe to touch.
 * Rejects traversal, absolute escapes, denylisted trees and secrets.
 */
function resolveInScope(p, scope, { write = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('path is required');
  const abs = path.resolve(REPO_ROOT, p);
  const relPath = rel(abs);

  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new ToolError(`path escapes the repository: ${p}`);
  }
  if (matchesAny(relPath, DENY_GLOBS)) {
    throw new ToolError(`path is on the global denylist: ${relPath}`);
  }
  // Secrets are unreadable, not merely unwritable: everything an agent reads is fed
  // to the model, echoed into the event stream, and persisted in the run history.
  if (matchesAny(relPath, SECRET_GLOBS)) {
    throw new ToolError(`refusing to ${write ? 'write to' : 'read'} a secret file: ${relPath}`);
  }
  if (scope?.exclude?.length && matchesAny(relPath, scope.exclude)) {
    throw new ToolError(`path is excluded from your scope: ${relPath}`);
  }
  if (write && scope?.include?.length && !matchesAny(relPath, scope.include)) {
    throw new ToolError(
      `path is outside your scope: ${relPath}. Your scope is: ${scope.include.join(', ')}. ` +
        `If this file genuinely needs changing, explain it in your finish() summary instead.`,
    );
  }
  return { abs, rel: relPath };
}

/** Pruned by name before the glob check — cheaper, and stops us descending into huge trees. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'dist',
  'build',
  'coverage',
  '.data',
  '_archive',
  'graphify-out',
  'logs',
  'uploads',
]);

/** Walk the repo once, cheaply, skipping denylisted trees. */
function walk(dirAbs, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dirAbs, e.name);
    const r = rel(abs);
    if (matchesAny(r, DENY_GLOBS) || matchesAny(r + '/', DENY_GLOBS)) continue;
    if (matchesAny(r, SECRET_GLOBS)) continue; // never even name a secret to the model
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, out, depth + 1);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

/** Files the agent is allowed to see, given its scope. */
function scopedFiles(scope) {
  return walk(REPO_ROOT).filter(
    (r) =>
      (!scope?.include?.length || matchesAny(r, scope.include)) &&
      !(scope?.exclude?.length && matchesAny(r, scope.exclude)),
  );
}

/* ------------------------- tool schema (Ollama fmt) ------------------------ */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List every file you are allowed to work on, optionally filtered by a glob. Call this first to orient yourself.',
      parameters: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: 'Optional filter, e.g. "backend/src/routes/*.js"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file with 1-indexed line numbers. Optionally pass start_line/end_line to read just a slice of a large file. Always read before changing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path' },
          start_line: { type: 'integer', description: 'Optional 1-indexed first line' },
          end_line: { type: 'integer', description: 'Optional 1-indexed last line' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'outline',
      description: 'List the functions, exports and routes declared in a file, with line numbers — a fast map of a file without reading all of it.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Regex search across the files in your scope. Returns matching lines with file:line references.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression' },
          glob: { type: 'string', description: 'Optional file filter' },
          max_results: { type: 'integer', description: 'Default 40' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'Find where a symbol (function, export, route path) is used across the codebase — the blast radius of changing it. ' +
        'Call this before changing anything shared, so you understand who depends on it.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'The name to look for, e.g. "requireAuth" or "/auth/login"' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_change',
      description:
        'Test your drafted change(s) in an isolated sandbox BEFORE proposing: runs a parse check, lint and the test suite. ' +
        'Returns pass/fail with the failure output so you can fix problems first. Use it after propose_change and before finish(). ' +
        'Proposing a change you have verified is far more valuable than proposing one blind.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description:
        'Commit to an implementation plan BEFORE you edit anything. State the single most critical improvement ' +
        'you found, how you will make it, and weigh its trade-offs honestly. You must submit a plan before your ' +
        'first stage_edit / propose_change. This forces you to think before acting.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The change you will make, imperative mood.' },
          criticality: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'How important is this vs. everything else you saw?' },
          approach: { type: 'string', description: 'How you will implement it — concrete.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files you will touch.' },
          pros: { type: 'array', items: { type: 'string' }, description: 'Benefits of making this change.' },
          cons: { type: 'array', items: { type: 'string' }, description: 'Costs / downsides — be honest.' },
          risks: { type: 'string', description: 'What could go wrong, and how you mitigate it.' },
        },
        required: ['title', 'criticality', 'approach', 'pros', 'cons'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_edit',
      description:
        'PREFERRED way to change an existing file: apply one exact string replacement. old_string must appear ' +
        'EXACTLY ONCE in the current file (add surrounding context to make it unique). Call it repeatedly to build ' +
        'up a change surgically — you never reproduce the whole file, so you cannot truncate it. Supply title and ' +
        'rationale on the first edit to a file. Then verify_change and finish.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path of an existing file' },
          old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
          new_string: { type: 'string', description: 'Replacement text' },
          title: { type: 'string', description: 'One-line summary (required on the first edit to this file)' },
          rationale: { type: 'string', description: 'Why this change matters (required on the first edit to this file)' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description:
        'Supply the complete new content of ONE file. Use this for NEW files or genuine full rewrites; for editing an ' +
        'existing file prefer stage_edit (it cannot truncate). The change is diffed, verified, and queued for review.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path. May be a new file.' },
          new_content: { type: 'string', description: 'The ENTIRE new file content. Never a diff, never a fragment.' },
          title: { type: 'string', description: 'One-line summary, imperative mood, e.g. "Add rate limiting to /auth/login"' },
          rationale: { type: 'string', description: 'Why this change matters. Reference the concrete problem it fixes.' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          confidence: { type: 'integer', description: 'Your confidence this is correct and mergeable, 0-100.' },
        },
        required: ['path', 'new_content', 'title', 'rationale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'critique_change',
      description:
        'Get an independent red-team review of your drafted change before proposing it: a second opinion that looks for ' +
        'correctness bugs, broken callers, convention mismatches, over-reach and security issues. Address its concerns ' +
        '(fix with stage_edit) or consciously reject them. Strongly recommended before finish().',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End your run. Call this when you have proposed your changes, or when you found nothing worth changing.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you examined and what you concluded.' },
        },
        required: ['summary'],
      },
    },
  },
];

/* ------------------------------ implementations ---------------------------- */

/**
 * @param {object} ctx  { scope, agentId, runId, maxProposals, onProposal }
 * Returns a map of tool name → async (args) => string (the observation shown to the model).
 */
const clampConfidence = (v, prev) => {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return prev ?? null;
  return Math.max(0, Math.min(100, Math.round(Number(v))));
};

export function makeTools(ctx) {
  const proposed = new Map(); // path → proposal payload, so a re-proposal replaces the earlier one
  let verifyCount = 0; // bounds how many times verify_change may run per run
  let critiqueCount = 0; // bounds how many times critique_change may run per run
  let plan = null; // the agent's committed implementation plan for this run

  return {
    async list_files({ glob }) {
      let files = scopedFiles(ctx.scope);
      if (glob) files = files.filter((f) => matchesAny(f, [glob]));
      if (!files.length) return 'No files match. Try a broader glob, or call list_files with no arguments.';
      const shown = files.slice(0, 300);
      return (
        `${files.length} file(s) in scope:\n` +
        shown.join('\n') +
        (files.length > shown.length ? `\n… ${files.length - shown.length} more (narrow with a glob)` : '')
      );
    },

    async read_file(args) {
      const p = args?.path;
      const { abs, rel: r } = resolveInScope(p, ctx.scope);
      if (!fs.existsSync(abs)) return `File does not exist: ${r}`;
      const raw = fs.readFileSync(abs, 'utf8');
      const allLines = raw.split('\n');

      // Optional line-range slice for large files.
      if (Number.isInteger(args?.start_line) || Number.isInteger(args?.end_line)) {
        const start = Math.max(1, args.start_line || 1);
        const end = Math.min(allLines.length, args.end_line || allLines.length);
        const slice = allLines
          .slice(start - 1, end)
          .map((line, i) => `${String(start + i).padStart(4)}  ${line}`)
          .join('\n');
        return `=== ${r} (lines ${start}-${end} of ${allLines.length}) ===\n${slice}`;
      }

      const truncated = raw.length > MAX_READ_BYTES;
      const body = truncated ? raw.slice(0, MAX_READ_BYTES) : raw;
      const numbered = body
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
        .join('\n');
      return (
        `=== ${r} (${allLines.length} lines) ===\n${numbered}` +
        (truncated
          ? `\n\n[TRUNCATED at ${MAX_READ_BYTES} bytes — read a specific range with start_line/end_line rather than rewriting blind]`
          : '')
      );
    },

    async outline({ path: p }) {
      const { abs, rel: r } = resolveInScope(p, ctx.scope);
      if (!fs.existsSync(abs)) return `File does not exist: ${r}`;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const out = [];
      lines.forEach((line, i) => {
        const ln = i + 1;
        let m;
        if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/))) out.push(`${ln}: function ${m[1]}(${m[2]})`);
        else if ((m = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/))) out.push(`${ln}: const ${m[1]} = (${m[2]}) =>`);
        else if ((m = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/))) out.push(`${ln}: class ${m[1]}`);
        else if ((m = line.match(/\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/))) out.push(`${ln}: ${m[1].toUpperCase()} ${m[2]}`);
        else if ((m = line.match(/^\s*(?:module\.)?exports\.([A-Za-z0-9_]+)\s*=/))) out.push(`${ln}: exports.${m[1]}`);
      });
      return out.length ? `=== outline of ${r} (${lines.length} lines) ===\n${out.join('\n')}` : `No named declarations found in ${r}.`;
    },

    async find_references({ symbol }) {
      if (!symbol || typeof symbol !== 'string') return 'symbol is required';
      const needle = symbol.trim();
      // Word-boundary match for identifiers; substring for route paths.
      const isIdent = /^[A-Za-z0-9_]+$/.test(needle);
      const re = isIdent ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
      const files = scopedFiles(ctx.scope);
      const hits = [];
      let files_touched = 0;
      for (const f of files) {
        let content;
        try {
          content = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue;
        let fileHit = false;
        content.split('\n').forEach((line, i) => {
          if (hits.length >= 60) return;
          const match = re ? re.test(line) : line.includes(needle);
          if (match) {
            hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
            fileHit = true;
          }
        });
        if (fileHit) files_touched++;
      }
      if (!hits.length) return `No references to "${needle}" found in your scope. It may be unused, or defined outside your scope.`;
      return `${hits.length} reference(s) to "${needle}" across ${files_touched} file(s) — this is the blast radius:\n${hits.join('\n')}`;
    },

    async verify_change() {
      const drafts = [...proposed.values()];
      if (!drafts.length) return 'You have no drafted changes yet. Call propose_change first, then verify_change.';
      if (ctx.verifyBudget !== undefined && verifyCount >= ctx.verifyBudget) {
        return `You have used all ${ctx.verifyBudget} verification attempts for this run. Fix issues from memory, or finish().`;
      }
      verifyCount++;
      ctx.onVerify?.(drafts.map((d) => d.path));
      const files = drafts.map((d) => ({ path: d.path, newContent: d.newContent }));
      let v;
      try {
        v = await ctx.verifyFiles(files);
      } catch (err) {
        return `Verification could not run: ${err.message}`;
      }
      if (v.skipped) return `No automated checks cover ${files.map((f) => f.path).join(', ')}. The change parses, but has no test coverage — proceed with care.`;
      if (v.ok) return `✓ VERIFIED — all checks pass (${v.checks.map((c) => c.name).join(', ')}). This is a strong proposal. Call finish().`;
      const failed = v.checks.find((c) => !c.ok);
      return (
        `✕ VERIFICATION FAILED at ${failed.name} (exit ${failed.exitCode}). Fix the problem, then propose_change again with the corrected file and re-verify.\n\n` +
        `--- output ---\n${(failed.output || '').slice(-2500)}`
      );
    },

    async search_code({ pattern, glob, max_results = 40 }) {
      let re;
      try {
        re = new RegExp(pattern, 'g');
      } catch (err) {
        return `Invalid regular expression: ${err.message}`;
      }
      const files = scopedFiles(ctx.scope).filter((f) => !glob || matchesAny(f, [glob]));
      const hits = [];
      for (const f of files) {
        if (hits.length >= max_results) break;
        let content;
        try {
          content = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\u0000')) continue; // binary
        content.split('\n').forEach((line, i) => {
          if (hits.length >= max_results) return;
          re.lastIndex = 0;
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return hits.length ? hits.join('\n') : `No matches for /${pattern}/`;
    },

    async submit_plan(args) {
      const { title, criticality = 'medium', approach = '', steps = [], files = [], pros = [], cons = [], risks = '' } = args || {};
      if (!title) return 'A plan needs at least a title.';
      if (!Array.isArray(pros) || !pros.length || !Array.isArray(cons) || !cons.length) {
        return 'Weigh the trade-offs honestly: provide at least one pro AND one con. A change with no downsides is a change you have not thought about.';
      }
      plan = { title, criticality, approach, steps: steps || [], files: files || [], pros, cons, risks };
      ctx.onPlan?.(plan);
      return (
        `Plan committed: "${title}" [${criticality}]. ${pros.length} pro(s), ${cons.length} con(s) weighed. ` +
        `Now implement it with stage_edit, verify_change, critique_change, then finish.`
      );
    },

    async propose_change({ path: p, new_content, title, rationale, severity = 'medium', confidence }) {
      if (!plan) return 'Submit a plan first (submit_plan) — decide the critical change and weigh its trade-offs before editing.';
      if (proposed.size >= ctx.maxProposals && !proposed.has(p)) {
        return `You have reached your limit of ${ctx.maxProposals} proposals for this run. Call finish() now.`;
      }
      if (typeof new_content !== 'string' || !new_content.trim()) {
        return 'new_content must be the complete, non-empty file content.';
      }
      const { abs, rel: r } = resolveInScope(p, ctx.scope, { write: true });

      const exists = fs.existsSync(abs);
      const oldContent = exists ? fs.readFileSync(abs, 'utf8') : '';
      if (exists && oldContent === new_content) {
        return `Your proposed content for ${r} is identical to the current file. Nothing to change.`;
      }
      if (exists && new_content.length < oldContent.length * 0.4) {
        return (
          `Rejected: your new content for ${r} is less than 40% the size of the original ` +
          `(${new_content.length} vs ${oldContent.length} bytes). You are very likely truncating the file — ` +
          `use stage_edit for surgical changes instead of reproducing the whole file.`
        );
      }

      const prev = proposed.get(r);
      proposed.set(r, {
        path: r,
        newContent: new_content,
        oldContent,
        isNew: !exists,
        title: title || prev?.title,
        rationale: rationale || prev?.rationale,
        severity,
        confidence: clampConfidence(confidence, prev?.confidence),
      });
      ctx.onProposal?.(r);
      return (
        `Proposal recorded for ${r} (${proposed.size}/${ctx.maxProposals}). ` +
        `Now prove it with verify_change (and consider critique_change), then finish.`
      );
    },

    async stage_edit({ path: p, old_string, new_string, title, rationale, severity, confidence }) {
      if (!plan) return 'Submit a plan first (submit_plan) — decide the critical change and weigh its trade-offs before editing.';
      if (proposed.size >= ctx.maxProposals && !proposed.has(p)) {
        return `You have reached your limit of ${ctx.maxProposals} proposals for this run. Call finish() now.`;
      }
      if (typeof old_string !== 'string' || !old_string) return 'old_string is required and must be non-empty.';
      const { abs, rel: r } = resolveInScope(p, ctx.scope, { write: true });
      if (!fs.existsSync(abs)) return `File does not exist: ${r}. Use propose_change to create a new file.`;

      const draft = proposed.get(r);
      const oldContent = draft ? draft.oldContent : fs.readFileSync(abs, 'utf8');
      const current = draft ? draft.newContent : oldContent; // apply successive edits to the evolving draft

      const count = current.split(old_string).length - 1;
      if (count === 0) {
        return `old_string was not found in the current draft of ${r}. Read the file (or your latest draft) and copy the exact text — including whitespace.`;
      }
      if (count > 1) {
        return `old_string appears ${count} times in ${r}. Add more surrounding context so it matches exactly once.`;
      }
      if (!draft && (!title || !rationale)) {
        return `This is your first edit to ${r} — provide title and rationale so the proposal has a summary.`;
      }

      const newContent = current.replace(old_string, new_string ?? '');
      proposed.set(r, {
        path: r,
        newContent,
        oldContent,
        isNew: false,
        title: title || draft?.title,
        rationale: rationale || draft?.rationale,
        severity: severity || draft?.severity || 'medium',
        confidence: clampConfidence(confidence, draft?.confidence),
      });
      ctx.onProposal?.(r);
      const edits = (draft?.edits || 0) + 1;
      proposed.get(r).edits = edits;
      return `Edit ${edits} applied to ${r} (draft now ${newContent.split('\n').length} lines). Stage more edits, or verify_change then finish.`;
    },

    async critique_change() {
      const drafts = [...proposed.values()];
      if (!drafts.length) return 'You have no drafted changes yet. Draft one with stage_edit or propose_change first.';
      if (!ctx.critique) return 'Critique is unavailable in this run.';
      if (ctx.critiqueBudget !== undefined && critiqueCount >= ctx.critiqueBudget) {
        return `You have used all ${ctx.critiqueBudget} critique(s) for this run. Decide and finish().`;
      }
      critiqueCount++;
      const { diff } = buildDiff(drafts.map((d) => ({ path: d.path, oldContent: d.oldContent, newContent: d.newContent, isNew: d.isNew })));
      try {
        const text = await ctx.critique(diff);
        return `RED-TEAM REVIEW of your draft — address these before finishing (fix with stage_edit), or explain why they don't apply:\n\n${text}`;
      } catch (err) {
        return `Critique could not run: ${err.message}`;
      }
    },

    async finish({ summary }) {
      return `__FINISH__${summary || 'done'}`;
    },

    /** Not exposed to the model — the runner drains these once the loop ends. */
    __collect: () => [...proposed.values()],
    __plan: () => plan,
  };
}

/** Build a unified diff + line stats for a set of proposed file changes. */
export function buildDiff(files) {
  let additions = 0;
  let deletions = 0;
  const chunks = files.map((f) => {
    const patch = createTwoFilesPatch(
      f.isNew ? '/dev/null' : `a/${f.path}`,
      `b/${f.path}`,
      f.oldContent,
      f.newContent,
      undefined,
      undefined,
      { context: 4 },
    );
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return patch;
  });
  return { diff: chunks.join('\n'), additions, deletions };
}

export { ToolError, resolveInScope, rel };
