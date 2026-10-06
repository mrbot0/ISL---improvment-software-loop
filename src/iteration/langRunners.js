import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../sandbox/worktree.js';

/**
 * POLYGLOT VERIFICATION ADAPTERS — the seam that makes ISL usable on ANY codebase.
 *
 * An enterprise control plane cannot assume JavaScript. Every ecosystem gets:
 *   - a cheap **syntax/compile check** per changed file (fast, per-file, no build needed),
 *   - a **test command** detected from what the repo actually contains,
 *   - a **lint command** where a standard one exists,
 *   - a **build command** for compiled languages, so "does it still compile?" is answerable.
 *
 * Everything degrades gracefully: a missing toolchain is reported as *skipped*, never as a failure,
 * so ISL never fails a change because the host lacks a compiler it doesn't need. Detection is
 * ordered most-specific first (e.g. pnpm/yarn before npm, Gradle before Maven when both exist).
 */

const NODE = process.execPath;
const has = (root, ...names) => names.some((n) => fs.existsSync(path.join(root, n)));
const hasGlob = (root, dir, re) => {
  try { return fs.readdirSync(path.join(root, dir)).some((f) => re.test(f)); } catch { return false; }
};

/* ───────────────────────────── syntax / compile checks ──────────────────────────── */

/**
 * Per-file checks. `cmd(abs, root)` gets the ABSOLUTE path and the sandbox root; `alt` is a fallback
 * binary tried before we conclude the toolchain is missing. `skipExit` names an exit code the
 * checker uses to say "I could not run here" in its own words, for checkers whose absence does not
 * look like a missing binary. Order matters only for overlapping extensions.
 */
/*
 * `fileURLToPath`, not `new URL(...).pathname`.
 *
 * The pathname of a file: URL is percent-encoded, so on a machine whose checkout contains a space —
 * such as this project's own "ISL improvment software loop" — the path arrives with `%20` in it,
 * resolves to nothing, and EVERY .ts/.tsx/.jsx file fails the gate with "cannot find module". A
 * verification tool that rejects valid code because of its own installation path is worse than one
 * that is missing. Found end-to-end: the checker worked perfectly when invoked by hand.
 */
const TS_SYNTAX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'checkers', 'tsSyntax.mjs');

const CHECKERS = [
  { id: 'node', ext: /\.(js|mjs|cjs)$/, cmd: (abs) => [NODE, ['--check', abs]] },
  /*
   * TypeScript, TSX and JSX had NO checker at all — `node --check` does not accept them, so a `.tsx`
   * with an unclosed element and a `.ts` that does not parse went through the gate untouched. On a
   * React or TypeScript codebase that is the largest category of file in the repo, unchecked.
   * Verified against a deliberately broken fixture before this existed: only the `.js` file was
   * caught; the `.jsx` and `.ts` both passed silently.
   */
  { id: 'typescript', ext: /\.(ts|tsx|jsx|mts|cts)$/, cmd: (abs, root) => [NODE, [TS_SYNTAX, root, abs]], skipExit: 3 },
  { id: 'python', ext: /\.py$/, cmd: (abs) => ['python', ['-m', 'py_compile', abs]], alt: 'python3' },
  { id: 'ruby', ext: /\.rb$/, cmd: (abs) => ['ruby', ['-c', abs]] },
  { id: 'php', ext: /\.php$/, cmd: (abs) => ['php', ['-l', abs]] },
  { id: 'go', ext: /\.go$/, cmd: (abs) => ['gofmt', ['-e', abs]] },
  { id: 'shell', ext: /\.(sh|bash)$/, cmd: (abs) => ['bash', ['-n', abs]] },
  { id: 'perl', ext: /\.p[lm]$/, cmd: (abs) => ['perl', ['-c', abs]] },
  { id: 'lua', ext: /\.lua$/, cmd: (abs) => ['luac', ['-p', abs]] },
  { id: 'yaml', ext: /\.ya?ml$/, cmd: (abs) => ['python', ['-c', `import sys,yaml;yaml.safe_load(open(sys.argv[1],encoding="utf-8"))`, abs]], alt: 'python3' },
  { id: 'json', ext: /\.json$/, cmd: (abs) => [NODE, ['-e', `JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))`, abs]] },
  { id: 'terraform', ext: /\.tf$/, cmd: (abs) => ['terraform', ['fmt', '-check=false', abs]] },
  { id: 'dart', ext: /\.dart$/, cmd: (abs) => ['dart', ['analyze', abs]] },
  { id: 'elixir', ext: /\.exs?$/, cmd: (abs) => ['elixir', ['-c', abs]] },
  { id: 'swift', ext: /\.swift$/, cmd: (abs) => ['swiftc', ['-parse', abs]] },
  { id: 'kotlin', ext: /\.kts?$/, cmd: (abs) => ['kotlinc', ['-script-templates', '-version', abs]] },
  { id: 'clojure', ext: /\.cljc?$/, cmd: (abs) => ['clojure', ['-M', '-e', `(read-string (slurp "${abs.replace(/\\/g, '/')}"))`]] },
  // TS/JSX/TSX, Java, C#, C/C++, Scala, Haskell need a real compiler with project context; a
  // per-file "check" there would false-fail on imports. Their BUILD/TEST adapters cover them, and
  // the dead-code, review, workbench and test gates still apply.
];

/* ──────────────────────────────── test suites ───────────────────────────────── */

/** Most-specific first: a repo with both gradle and maven should use gradle. */
const TEST_SUITES = [
  // JavaScript / TypeScript — prefer the locally installed runner (no network, exact version).
  { id: 'vitest', detect: (r) => fs.existsSync(path.join(r, 'node_modules/vitest/vitest.mjs')), cmd: (r) => [NODE, [path.join(r, 'node_modules/vitest/vitest.mjs'), 'run']] },
  { id: 'jest', detect: (r) => fs.existsSync(path.join(r, 'node_modules/jest/bin/jest.js')), cmd: (r) => [NODE, [path.join(r, 'node_modules/jest/bin/jest.js'), '--ci', '--silent']] },
  { id: 'mocha', detect: (r) => fs.existsSync(path.join(r, 'node_modules/mocha/bin/mocha.js')), cmd: (r) => [NODE, [path.join(r, 'node_modules/mocha/bin/mocha.js')]] },
  // Node's built-in runner. Increasingly common precisely because it needs no dependency — which is
  // also why it was invisible here: every detector above looks inside node_modules, so a project
  // using `node --test` reported "no test suite detected" and the grader scored it 100 for running
  // nothing at all. Deliberately LAST among the JS runners (an installed runner still wins) and
  // deliberately narrow: the package.json test script must literally invoke `node --test`. A looser
  // detector would fire on projects whose *.test.js files are written in vitest syntax and fail them
  // for using an API this runner does not have.
  {
    id: 'node-test',
    detect: (r) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf8'));
        return /\bnode\b[^&|]*--test\b/.test(String(pkg?.scripts?.test || ''));
      } catch {
        return false;
      }
    },
    cmd: () => [NODE, ['--test']],
  },
  // Python
  { id: 'pytest', detect: (r) => has(r, 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'), cmd: () => ['pytest', ['-q']] },
  // JVM
  { id: 'gradle', detect: (r) => has(r, 'gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts'), cmd: (r) => [gradleBin(r), ['test', '--console=plain', '-q']] },
  { id: 'maven', detect: (r) => has(r, 'pom.xml'), cmd: (r) => [mvnBin(r), ['-q', '-B', 'test']] },
  // .NET
  { id: 'dotnet', detect: (r) => has(r, 'global.json') || hasGlob(r, '.', /\.(sln|csproj|fsproj|vbproj)$/), cmd: () => ['dotnet', ['test', '--nologo', '-v', 'q']] },
  // Go / Rust
  { id: 'go', detect: (r) => has(r, 'go.mod'), cmd: () => ['go', ['test', './...']] },
  { id: 'cargo', detect: (r) => has(r, 'Cargo.toml'), cmd: () => ['cargo', ['test', '--quiet']] },
  // Ruby / PHP
  { id: 'rspec', detect: (r) => has(r, '.rspec') || fs.existsSync(path.join(r, 'spec')), cmd: () => ['rspec', ['--no-color']] },
  { id: 'rake', detect: (r) => has(r, 'Rakefile'), cmd: () => ['rake', ['test']] },
  { id: 'phpunit', detect: (r) => has(r, 'phpunit.xml', 'phpunit.xml.dist') || fs.existsSync(path.join(r, 'vendor/bin/phpunit')), cmd: (r) => (fs.existsSync(path.join(r, 'vendor/bin/phpunit')) ? [path.join(r, 'vendor/bin/phpunit'), []] : ['phpunit', []]) },
  // Mobile / functional / others
  { id: 'flutter', detect: (r) => has(r, 'pubspec.yaml') && fs.existsSync(path.join(r, 'test')), cmd: () => ['flutter', ['test']] },
  { id: 'dart', detect: (r) => has(r, 'pubspec.yaml'), cmd: () => ['dart', ['test']] },
  { id: 'swift', detect: (r) => has(r, 'Package.swift'), cmd: () => ['swift', ['test']] },
  { id: 'mix', detect: (r) => has(r, 'mix.exs'), cmd: () => ['mix', ['test']] },
  { id: 'sbt', detect: (r) => has(r, 'build.sbt'), cmd: () => ['sbt', ['-batch', 'test']] },
  { id: 'stack', detect: (r) => has(r, 'stack.yaml'), cmd: () => ['stack', ['test']] },
  { id: 'cabal', detect: (r) => hasGlob(r, '.', /\.cabal$/), cmd: () => ['cabal', ['test']] },
  { id: 'ctest', detect: (r) => has(r, 'CMakeLists.txt'), cmd: () => ['ctest', ['--output-on-failure']] },
  { id: 'composer', detect: (r) => has(r, 'composer.json'), cmd: () => ['composer', ['test']] },
];

/* ────────────────────────────── build & lint ──────────────────────────────── */

/** "Does it still compile?" for languages where a per-file syntax check isn't meaningful. */
const BUILD_CMDS = [
  { id: 'tsc', detect: (r) => has(r, 'tsconfig.json') && fs.existsSync(path.join(r, 'node_modules/typescript/bin/tsc')), cmd: (r) => [NODE, [path.join(r, 'node_modules/typescript/bin/tsc'), '--noEmit']] },
  { id: 'gradle', detect: (r) => has(r, 'gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts'), cmd: (r) => [gradleBin(r), ['compileJava', '--console=plain', '-q']] },
  { id: 'maven', detect: (r) => has(r, 'pom.xml'), cmd: (r) => [mvnBin(r), ['-q', '-B', 'compile']] },
  { id: 'dotnet', detect: (r) => hasGlob(r, '.', /\.(sln|csproj|fsproj)$/), cmd: () => ['dotnet', ['build', '--nologo', '-v', 'q']] },
  { id: 'go', detect: (r) => has(r, 'go.mod'), cmd: () => ['go', ['build', './...']] },
  { id: 'cargo', detect: (r) => has(r, 'Cargo.toml'), cmd: () => ['cargo', ['check', '--quiet']] },
  { id: 'swift', detect: (r) => has(r, 'Package.swift'), cmd: () => ['swift', ['build']] },
  { id: 'mix', detect: (r) => has(r, 'mix.exs'), cmd: () => ['mix', ['compile', '--warnings-as-errors']] },
  { id: 'cmake', detect: (r) => has(r, 'CMakeLists.txt'), cmd: () => ['cmake', ['--build', '.']] },
];

/** Standard linters, used as an advisory signal (never a hard veto). */
const LINT_CMDS = [
  { id: 'eslint', detect: (r) => fs.existsSync(path.join(r, 'node_modules/eslint/bin/eslint.js')), cmd: (r) => [NODE, [path.join(r, 'node_modules/eslint/bin/eslint.js'), '.', '--max-warnings=0']] },
  { id: 'ruff', detect: (r) => has(r, 'ruff.toml', '.ruff.toml') || has(r, 'pyproject.toml'), cmd: () => ['ruff', ['check', '.']] },
  { id: 'golangci', detect: (r) => has(r, '.golangci.yml', '.golangci.yaml'), cmd: () => ['golangci-lint', ['run']] },
  { id: 'clippy', detect: (r) => has(r, 'Cargo.toml'), cmd: () => ['cargo', ['clippy', '--quiet']] },
  { id: 'rubocop', detect: (r) => has(r, '.rubocop.yml'), cmd: () => ['rubocop', ['--format', 'simple']] },
  { id: 'phpstan', detect: (r) => has(r, 'phpstan.neon', 'phpstan.neon.dist'), cmd: () => ['phpstan', ['analyse', '--no-progress']] },
  { id: 'ktlint', detect: (r) => has(r, '.editorconfig') && has(r, 'build.gradle.kts'), cmd: () => ['ktlint', []] },
];

/** Prefer the project's own wrapper (exact version, no global install needed). */
function gradleBin(root) {
  if (process.platform === 'win32' && fs.existsSync(path.join(root, 'gradlew.bat'))) return path.join(root, 'gradlew.bat');
  if (fs.existsSync(path.join(root, 'gradlew'))) return path.join(root, 'gradlew');
  return 'gradle';
}
function mvnBin(root) {
  if (process.platform === 'win32' && fs.existsSync(path.join(root, 'mvnw.cmd'))) return path.join(root, 'mvnw.cmd');
  if (fs.existsSync(path.join(root, 'mvnw'))) return path.join(root, 'mvnw');
  return 'mvn';
}

// A tool is "absent" (skip, don't fail) when the OS can't find the binary.
/**
 * Did the COMMAND fail to start, as opposed to running and reporting failures?
 *
 * The distinction matters because a missing tool is *skipped* while a real failure is a finding, and
 * getting it backwards in either direction is bad: skip a real failure and a broken change looks
 * clean; fail a missing toolchain and a change is rejected for what the host lacks.
 *
 * The old pattern matched `not found` and `No such file` ANYWHERE in the output, so any suite that
 * printed those words in an assertion or a module-resolution error was read as an absent toolchain.
 * Seen on a real run: the coverage gate reported "vitest is not installed on this host" for a
 * directory where vitest was installed and had just executed — the suite had simply printed
 * "Does the file exist?" while failing.
 *
 * These markers are produced by the process spawner or the shell, not by a program's own output:
 *   - `ENOENT` with `spawn`, which is how Node reports an executable that is not there
 *   - the exact cmd.exe and POSIX shell phrasings for an unknown command
 * A test runner printing about a missing *module* no longer counts, because that is the runner
 * working and telling you something true about the code.
 */
const isToolMissing = (output = '') => {
  const s = String(output || '');
  return /spawn\s+\S+\s+ENOENT/i.test(s)
    || /\bENOENT\b.*\bspawn\b/i.test(s)
    || /is not recognized as an internal or external command/i.test(s)
    || /^[^\n]*:\s*command not found/im.test(s)
    || /^[^\n]*:\s*[^\n]*: No such file or directory/im.test(s);
};

/* ─────────────────────────────────── API ──────────────────────────────────── */

/**
 * Run the right syntax check for each changed file, across languages. Returns parse issues
 * (real syntax errors) and which languages were skipped for lack of a toolchain.
 */
export async function parseCheckAll(sandboxRoot, changedFiles = []) {
  const issues = [];
  const skipped = new Set();
  const checkedLangs = new Set();

  for (const rel of changedFiles) {
    const checker = CHECKERS.find((c) => c.ext.test(rel));
    if (!checker) continue;
    const abs = path.join(sandboxRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const [bin, args] = checker.cmd(abs, sandboxRoot);
    let res = await run(bin, args, { cwd: sandboxRoot, timeoutMs: 25000 }).catch((e) => ({ exitCode: 127, output: String(e.message) }));
    if (res.exitCode !== 0 && isToolMissing(res.output) && checker.alt) {
      const [, altArgs] = checker.cmd(abs, sandboxRoot);
      res = await run(checker.alt, altArgs, { cwd: sandboxRoot, timeoutMs: 25000 }).catch((e) => ({ exitCode: 127, output: String(e.message) }));
    }
    if (res.exitCode === 0) {
      checkedLangs.add(checker.id);
    // A checker that reports its own unavailability. Without this the message would be read as a
    // diagnosis and the change failed for the host's missing tooling — the one thing this module
    // promises never to do.
    } else if (checker.skipExit != null && res.exitCode === checker.skipExit) {
      skipped.add(checker.id);
    } else if (isToolMissing(res.output)) {
      skipped.add(checker.id);
    } else {
      /*
       * THE OFFENDING LINE, NOT JUST ITS NUMBER.
       *
       * "SyntaxError: Unexpected token ';' at hardening.js:100" tells an agent that it broke
       * something and nothing about what. Measured: the same file failed the parse gate on **nine
       * consecutive runs**, and the lesson the memory system learned from it each time was the
       * generic "a file you edited is not valid source" — which cannot change what the agent writes
       * next, so it wrote the same mistake again.
       *
       * With the source line attached the diagnosis becomes `log?.info?({ sig }, …)` and the fix is
       * self-evident: `?.(`, not `?(`. A lesson is only worth carrying if it names the thing to do
       * differently.
       */
      issues.push(`${rel}: ${diagnosticFrom(res.output, abs)}`.slice(0, 400));
    }
  }
  return { issues, skipped: [...skipped], checkedLangs: [...checkedLangs] };
}

/**
 * The line of a parse-checker's output that actually says what is WRONG.
 *
 * Taking the first non-empty line was almost always the wrong one. `node --check` prints the
 * absolute path and line number first and the `SyntaxError` several lines later, so a real failure
 * was recorded as `services/payments/src/hardening.js: C:\…\hardening.js:270` — a location and
 * nothing else. Three runs scored 0 on review with that as their entire explanation, which is
 * indistinguishable from a score nobody computed.
 *
 * Every checker here reports its diagnosis differently, so this looks for the line that carries a
 * recognised error keyword and falls back to the first line only when none does — the old behaviour,
 * kept for a checker whose format nobody has met yet.
 */
function diagnosticFrom(output, absFile = null) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'syntax error (the checker produced no output)';

  // node: "SyntaxError: …"; python: "SyntaxError: …" / "IndentationError: …"; ruby/php/perl: "syntax error, …";
  // go (gofmt -e): "file:line:col: expected …"; bash: "syntax error near …".
  const diagnostic = lines.find((l) => /(?:^|\s)(?:\w*Error|error|invalid|expected|unexpected|unterminated|missing)\b/i.test(l)
    // Skip the bare "path:line" and "path:line:col" forms — a location is not a diagnosis.
    && !/^[A-Za-z]?:?[\\/].*:\d+(?::\d+)?$/.test(l));
  if (!diagnostic) return lines[0];

  // Keep the location alongside the diagnosis when the checker gave both: "what" without "where"
  // is only half an answer.
  const location = lines.find((l) => /:\d+(?::\d+)?$/.test(l) && l !== diagnostic);
  const where = location ? location.split(/[\\/]/).pop() : null;
  const base = where ? `${diagnostic} (at ${where})` : diagnostic;

  // And the source of that line, which is the half that makes it fixable.
  const src = where && absFile ? sourceLineAt(absFile, Number(/:(\d+)/.exec(where)?.[1])) : null;
  return src ? `${base} → \`${src}\`` : base;
}

/** The trimmed text of one line, for quoting back the code that failed to parse. */
function sourceLineAt(absFile, lineNo) {
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  try {
    const line = fs.readFileSync(absFile, 'utf8').split(/\r?\n/)[lineNo - 1];
    const t = String(line ?? '').trim();
    return t ? t.slice(0, 160) : null;
  } catch {
    return null; // the file moved or is unreadable — the location alone still stands
  }
}

/** Generic "first adapter whose detector matches" lookup. */
function pick(list, sandboxRoot, projectDir) {
  const root = path.join(sandboxRoot, projectDir);
  for (const s of list) {
    try {
      if (s.detect(root)) {
        const [bin, args] = s.cmd(root);
        return { id: s.id, bin, args, cwd: root };
      }
    } catch { /* a detector must never throw the pipeline */ }
  }
  return null;
}

/** The test command for a project directory, or null if no known suite is present. */
export const testCommandFor = (sandboxRoot, projectDir = '.') => pick(TEST_SUITES, sandboxRoot, projectDir);
/** The compile/typecheck command, for languages where syntax alone proves nothing. */
export const buildCommandFor = (sandboxRoot, projectDir = '.') => pick(BUILD_CMDS, sandboxRoot, projectDir);
/** The lint command (advisory). */
export const lintCommandFor = (sandboxRoot, projectDir = '.') => pick(LINT_CMDS, sandboxRoot, projectDir);

/** Everything ISL can verify for a directory — used by the dashboard's capability report. */
export function toolchainFor(sandboxRoot, projectDir = '.') {
  return {
    projectDir,
    test: testCommandFor(sandboxRoot, projectDir),
    build: buildCommandFor(sandboxRoot, projectDir),
    lint: lintCommandFor(sandboxRoot, projectDir),
  };
}

/** All ecosystems this build of ISL knows how to verify (for docs and the UI). */
export const SUPPORTED = {
  syntax: CHECKERS.map((c) => c.id),
  test: TEST_SUITES.map((s) => s.id),
  build: BUILD_CMDS.map((b) => b.id),
  lint: LINT_CMDS.map((l) => l.id),
};

export { isToolMissing };
