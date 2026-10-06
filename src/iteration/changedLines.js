import path from 'node:path';

/**
 * WHICH LINES DID THIS CHANGE ACTUALLY ADD?
 *
 * The coverage-of-changed-lines gate (ISL_IMPROVE §1, P0) needs one fact the rest of the pipeline
 * never computed: for each file the change touches, the set of line numbers **in the new file** that
 * this change introduced or rewrote. Whole-file coverage cannot answer it — a 4000-line module at
 * 90% tells you nothing about whether the 12 lines just added are among the 400 that nobody runs,
 * and those 12 lines are the entire risk of the change.
 *
 * Everything here is pure: a unified diff in, line numbers out. That matters, because a bug in this
 * parser would silently mis-attribute coverage — vetoing good changes or, worse, waving through
 * untested ones — and a pure function is the only kind that can be pinned by tests cheaply enough to
 * actually be pinned.
 */

/** Files whose "uncovered" lines are not a defect, so the gate must never judge them. */
const NEVER_JUDGED = [
  // A test's own lines are not the subject of the test.
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|fixtures?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  // Declarations and generated artefacts contain no executable behaviour to exercise.
  /\.d\.ts$/i,
  /(^|\/)(dist|build|out|coverage|vendor|node_modules|target|\.next)\//i,
  /\.(min|bundle)\.[cm]?js$/i,
  /(^|\/)migrations?\//i,
  // Configuration, documentation, data and lockfiles.
  /\.(md|mdx|txt|json|ya?ml|toml|ini|cfg|lock|snap|svg|png|jpe?g|gif|ico|woff2?|ttf|csv)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/i,
  /\.(config|conf)\.[cm]?[jt]s$/i,
  /(^|\/)\.[^/]+$/, // dotfiles
];

/** Extensions the coverage adapters can actually instrument. Anything else is not judged. */
const INSTRUMENTABLE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.java', '.kt']);

/**
 * Should the gate hold this file's changed lines to a coverage standard?
 *
 * Answering "no" generously is deliberate. A gate that fires on a YAML file or a test helper trains
 * operators to bypass it, and a gate that is routinely bypassed protects nothing at all.
 */
export function isJudged(file) {
  const rel = String(file || '').split(path.sep).join('/');
  if (!rel) return false;
  if (!INSTRUMENTABLE.has(path.posix.extname(rel).toLowerCase())) return false;
  return !NEVER_JUDGED.some((re) => re.test(rel));
}

/**
 * Parse a unified diff into `{ file → Set<lineNumber> }`, counting lines in the NEW file.
 *
 * Only additions are collected. A deleted line has no line number in the new file to cover, and a
 * context line was already there — attributing it to this change would blame an author for coverage
 * debt they inherited, which is the fastest way to make a gate feel unfair and get it switched off.
 */
/**
 * The post-image paths a unified diff touches.
 *
 * One owner for one concept. Three copies of this had appeared — here, in the review grader and in
 * the schema guard — and the two newer ones were subtly worse: neither dropped `/dev/null` (so a
 * deleted file contributed a path that exists nowhere) nor stripped the trailing tab that some git
 * configurations append to the `+++` line.
 *
 * `+++ b/path` is authoritative: it survives renames, and unlike the `diff --git` header it is
 * unambiguous when a path contains a space.
 */
export function changedPaths(diff) {
  const out = [];
  if (!diff || typeof diff !== 'string') return out;
  for (const raw of diff.split(/\r?\n/)) {
    if (!raw.startsWith('+++ ')) continue;
    const p = raw.slice(4).trim().replace(/\t.*$/, '');
    if (p === '/dev/null') continue;
    const rel = p.replace(/^[ab]\//, '');
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}

export function addedLinesByFile(diff) {
  const out = new Map();
  if (!diff || typeof diff !== 'string') return out;

  let file = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split(/\r?\n/)) {
    // `+++ b/path` is the authoritative new path: it survives renames, and unlike the `diff --git`
    // header it is unambiguous when a path contains a space.
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim().replace(/\t.*$/, '');
      file = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ')) { inHunk = false; continue; }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      // A hunk with a zero new-line count deletes only; there is nothing in the new file to walk.
      inHunk = hunk[2] === undefined || Number(hunk[2]) > 0;
      continue;
    }
    if (!inHunk || !file) continue;

    if (raw.startsWith('+')) {
      if (!out.has(file)) out.set(file, new Set());
      out.get(file).add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // Deletions consume a line of the OLD file only.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — a marker, not content.
    } else if (raw.startsWith(' ') || raw === '') {
      newLine++;
    } else {
      // Anything else means the hunk ended (a stray trailer, a new file header we mis-split).
      inHunk = false;
    }
  }
  return out;
}

/**
 * The changed lines the gate will actually judge — additions in files that carry behaviour.
 * Returns `[{ file, lines: number[] }]`, sorted, with unjudged files dropped entirely.
 */
export function judgedChangedLines(diff) {
  const out = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (!isJudged(file)) continue;
    if (!lines.size) continue;
    out.push({ file, lines: [...lines].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
