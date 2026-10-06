/**
 * Syntax check for TypeScript, TSX and JSX — the file types the parse gate could not see.
 *
 * `node --check` handles `.js`, `.mjs` and `.cjs` and nothing else, so a `.tsx` with an unclosed
 * element and a `.ts` that does not parse both went through the gate untouched. On a React or
 * TypeScript codebase — which is most of them — that left the largest category of file in the repo
 * with no syntax check at all, and a change that could not possibly build was scored on its diff
 * and committed.
 *
 * Run as: node tsSyntax.mjs <repo-root> <file>
 *   exit 0 → parses
 *   exit 1 → a diagnostic on stdout
 *   exit 3 → no usable parser in this repo (the caller must treat this as SKIPPED, never as a pass)
 *
 * It parses with whatever the TARGET repo already has — its own TypeScript, or the esbuild that
 * ships inside Vite — rather than a copy pinned here. A syntax checker on a version different from
 * the project's own will eventually disagree with the project's build about what is valid, and a
 * gate that rejects code the build accepts is worse than one that is occasionally absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [, , root, file] = process.argv;

if (!root || !file) {
  process.stdout.write('usage: tsSyntax.mjs <repo-root> <file>\n');
  process.exit(3);
}

const source = (() => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
})();
if (source == null) {
  process.stdout.write(`cannot read ${file}\n`);
  process.exit(3);
}

/** Resolve a package from the target repo, walking up from the file's own directory. */
function fromRepo(pkg) {
  const bases = [path.dirname(file), root];
  for (const base of bases) {
    try {
      return createRequire(path.join(base, 'noop.js'))(pkg);
    } catch { /* try the next base */ }
  }
  return null;
}

const ext = path.extname(file).toLowerCase();

/* ── TypeScript's own parser, when the repo has one ───────────────────────── */
/*
 * Wrapped, and it falls THROUGH to esbuild on any failure rather than reporting one.
 *
 * `transpileModule` is public API, but this branch could not be exercised on the machine this was
 * written on — no repository here has TypeScript installed — so it is written to be wrong safely.
 * If the shape of a diagnostic differs from what this expects, the cost is that the file is parsed
 * by esbuild instead. If it threw, the cost would be a valid change failing the gate with a stack
 * trace, which is the failure mode a verification tool must never have.
 */
const ts = (() => { try { return fromRepo('typescript'); } catch { return null; } })();
try {
if (ts) {
  // `transpileModule` is public API and reports syntactic diagnostics. Type errors need a full
  // program with a tsconfig — that is the separate, project-level check, not this one.
  const out = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      // Preserve JSX rather than transform it: this is a parse, and asking for a transform would
      // pull in decisions (jsxFactory, runtime) that belong to the project's own build.
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      allowJs: true,
      isolatedModules: true,
    },
  });
  // Only syntactic categories. `transpileModule` also emits advisory diagnostics about options,
  // and failing a change for "this option is not supported in isolatedModules" would be nonsense.
  const syntactic = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error && d.code < 2000);
  if (syntactic.length) {
    const d = syntactic[0];
    const where = d.file && d.start != null
      ? (() => { const p = d.file.getLineAndCharacterOfPosition(d.start); return `:${p.line + 1}:${p.character + 1}`; })()
      : '';
    process.stdout.write(`SyntaxError: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (at ${path.basename(file)}${where})\n`);
    process.exit(1);
  }
  process.exit(0);
}
} catch {
  // Fall through to esbuild. Deliberately silent: this is not a finding about the operator's code.
}

/* ── esbuild, which every Vite project already carries ─────────────────────── */
const esbuild = fromRepo('esbuild');
if (esbuild) {
  const loader = ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js';
  try {
    esbuild.transformSync(source, { loader, sourcefile: file });
    process.exit(0);
  } catch (err) {
    const e = err?.errors?.[0];
    const where = e?.location ? ` (at ${path.basename(file)}:${e.location.line}:${e.location.column})` : '';
    process.stdout.write(`SyntaxError: ${e?.text || err.message}${where}\n`);
    process.exit(1);
  }
}

// Neither parser is here. Say so plainly — the caller records this as a skipped language, and the
// alternative (exiting 0) would be the gate reporting a pass it never checked.
process.stdout.write('no TypeScript or esbuild in this repo — cannot parse .ts/.tsx/.jsx\n');
process.exit(3);
