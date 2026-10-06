import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLinesByFile, judgedChangedLines, isJudged } from '../src/iteration/changedLines.js';

/**
 * The diff parser the coverage gate stands on.
 *
 * A bug here mis-attributes coverage in the direction nobody notices: lines credited to the wrong
 * file, or a line count that quietly drifts from git's. These use `node:test`, which ships with the
 * runtime, so the engine gains a suite without gaining a dependency.
 *
 * The strongest check on this parser is not here but in the cross-check against `git diff --numstat`
 * over real history — 151 files, zero mismatches. These pin the edge cases that a repo's history
 * happens not to contain today but will contain eventually.
 */

const diff = (s) => s.replace(/^\n/, '');

test('counts additions against the new file, ignoring deletions', () => {
  const d = diff(`
diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
`);
  assert.deepEqual([...addedLinesByFile(d).get('a.js')], [2, 3]);
});

test('a hunk header without a line count means exactly one line', () => {
  const d = diff(`
--- a/a.js
+++ b/a.js
@@ -5 +5 @@
-old
+new
`);
  assert.deepEqual([...addedLinesByFile(d).get('a.js')], [5]);
});

test('"\\ No newline at end of file" is a marker, not content', () => {
  // Left unhandled this shifts every subsequent line number by one — the kind of off-by-one that
  // silently blames the wrong line for being uncovered.
  const d = diff(`
--- a/a.js
+++ b/a.js
@@ -1,2 +1,2 @@
 a
-b
\\ No newline at end of file
+b
+c
`);
  assert.deepEqual([...addedLinesByFile(d).get('a.js')], [2, 3]);
});

test('tracks several files in one diff without leaking lines between them', () => {
  const d = diff(`
--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
 a
+added-to-a
--- a/b.js
+++ b/b.js
@@ -10,1 +10,2 @@
 b
+added-to-b
`);
  const out = addedLinesByFile(d);
  assert.deepEqual([...out.get('a.js')], [2]);
  assert.deepEqual([...out.get('b.js')], [11]);
});

test('a deleted file contributes nothing — /dev/null has no lines to cover', () => {
  const d = diff(`
--- a/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`);
  assert.equal(addedLinesByFile(d).size, 0);
});

test('a new file counts from line 1', () => {
  const d = diff(`
--- /dev/null
+++ b/new.js
@@ -0,0 +1,3 @@
+one
+two
+three
`);
  assert.deepEqual([...addedLinesByFile(d).get('new.js')], [1, 2, 3]);
});

test('survives empty and malformed input rather than throwing', () => {
  // This runs inside the commit path; an exception here would fail a change for a parser's sake.
  for (const bad of ['', null, undefined, 'not a diff at all', '@@ garbage @@']) {
    assert.equal(addedLinesByFile(bad).size, 0);
  }
});

test('judges source files and exempts everything that cannot be tested', () => {
  assert.equal(isJudged('src/pay.js'), true);
  assert.equal(isJudged('app/main.py'), true);
  assert.equal(isJudged('cmd/server.go'), true);

  // A test's own lines are not the subject of the test.
  assert.equal(isJudged('src/pay.test.js'), false);
  assert.equal(isJudged('src/__tests__/pay.js'), false);
  assert.equal(isJudged('app/test_pay.py'), false);
  assert.equal(isJudged('pkg/pay_test.go'), false);
  // Nothing executable to exercise.
  assert.equal(isJudged('types/api.d.ts'), false);
  assert.equal(isJudged('README.md'), false);
  assert.equal(isJudged('package.json'), false);
  assert.equal(isJudged('vite.config.js'), false);
  assert.equal(isJudged('dist/bundle.js'), false);
  assert.equal(isJudged('db/migrations/001_init.js'), false);
});

test('judgedChangedLines drops exempt files but keeps their neighbours', () => {
  const d = diff(`
--- a/src/pay.js
+++ b/src/pay.js
@@ -1,1 +1,2 @@
 a
+real code
--- a/src/pay.test.js
+++ b/src/pay.test.js
@@ -1,1 +1,2 @@
 a
+test code
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 a
+prose
`);
  assert.deepEqual(judgedChangedLines(d), [{ file: 'src/pay.js', lines: [2] }]);
});
