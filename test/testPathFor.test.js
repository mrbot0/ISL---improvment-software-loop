import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPathFor } from '../src/iteration/implementer.js';

/**
 * Where a test file lives beside its source.
 *
 * The planner now states, per candidate, whether a test file already exists — the fact that stops it
 * proposing "add unit tests for X" against files that have them. That check is only as good as this
 * mapping: get the path wrong and every file looks untested, which is exactly the state that
 * produced eleven wasted agent turns.
 *
 * Verified against the real backlog when this landed: 3 of the next 10 candidates were correctly
 * identified as already having tests, including the file that had failed nine runs in a row.
 */

test('a plain source file maps to __tests__ beside it', () => {
  assert.equal(testPathFor('backend/server/lib/crypto.js'), 'backend/server/lib/__tests__/crypto.test.js');
});

test('a JSX component keeps its extension', () => {
  // `.test.js` beside a `.jsx` component would not be picked up by a JSX-aware runner config.
  assert.equal(testPathFor('frontend/app/pages/Login.jsx'), 'frontend/app/pages/__tests__/Login.test.jsx');
  assert.equal(testPathFor('src/Button.tsx'), 'src/__tests__/Button.test.tsx');
});

test('.mjs, .cjs and .ts collapse to .test.js', () => {
  assert.equal(testPathFor('lib/util.mjs'), 'lib/__tests__/util.test.js');
  assert.equal(testPathFor('lib/util.cjs'), 'lib/__tests__/util.test.js');
  assert.equal(testPathFor('lib/util.ts'), 'lib/__tests__/util.test.js');
});

test('a file at the repo root still resolves', () => {
  // Without the `.` branch this produced `/__tests__/…`, an absolute path that exists nowhere —
  // so a root-level file would always read as untested.
  assert.equal(testPathFor('index.js'), './__tests__/index.test.js');
});

test('backslashes are normalised', () => {
  // Paths reach this from git, from the DB and from Windows APIs; only one of those uses forward
  // slashes, and a mismatched separator makes the existence check silently false.
  assert.equal(testPathFor('backend\\server\\lib\\crypto.js'), 'backend/server/lib/__tests__/crypto.test.js');
});

test('a name containing a dot is not truncated at it', () => {
  assert.equal(testPathFor('lib/api.v2.js'), 'lib/__tests__/api.v2.test.js');
});
