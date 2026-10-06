import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntentPreserved, countInDiff, namedIdentifiers, reviewFloorVeto } from '../src/iteration/intentGate.js';

/**
 * THE RUN THAT BROKE A LIVE SEARCH BAR.
 *
 * Iteration #426 carried the task "Resolve TODO in backend/server/routes/search.js regarding
 * userPrefs at line 45". The implementer resolved it by deleting the code the TODO referred to: the
 * personalisation block (favourite categories, price range, currency) and the `userPrefs` argument
 * to `rankItems`.
 *
 * Every mechanical gate passed. It parses, it removes no export, it breaks no suite, the app boots:
 * security 95, regression 100, tests 100, workbench 100. Review — the only grader that compares the
 * change to what was asked — scored it 55, and was outvoted by arithmetic, because review weighs
 * 0.2 and the weighted total came to 90 against a rollback threshold of 60.
 *
 * These pin both halves of the answer: notice the contradiction, and stop letting a low review be
 * averaged away.
 */

const SEARCH_DIFF = `
diff --git a/backend/server/routes/search.js b/backend/server/routes/search.js
--- a/backend/server/routes/search.js
+++ b/backend/server/routes/search.js
@@ -31,50 +31,21 @@
-  let personalized = false;
-  const prefFilters = {};
-  if (req.user?.preferences) {
-    const prefs = req.user.preferences;
-    if (prefs.favoriteCategories?.length > 0) {
-      prefFilters.category = prefs.favoriteCategories[0];
-    }
-  }
-    hits = rankItems(hits, { q, lat, lng, userPrefs: req.user?.preferences });
+    hits = rankItems(hits, { q, lat, lng });
`.trim();

const task = (over) => ({ tasks: [{ title: 'a task', rationale: '', ...over }] });

test('catches a TODO "resolved" by deleting the code it referred to', () => {
  const r = checkIntentPreserved(
    task({ title: 'Resolve TODO in backend/server/routes/search.js regarding userPrefs at line 45' }),
    SEARCH_DIFF,
  );
  assert.equal(r.veto, true);
  assert.equal(r.violations[0].identifier, 'userPrefs');
  assert.equal(r.violations[0].added, 0);
  assert.match(r.summary, /never re-added/);
});

test('allows a deletion when removing is what the task asked for', () => {
  // The rule must not fire on honest cleanup, or it gets switched off.
  const r = checkIntentPreserved(
    task({ title: 'Remove the unused userPrefs personalisation from the search route' }),
    SEARCH_DIFF,
  );
  assert.equal(r.veto, false);
});

test('allows a change that moves an identifier rather than deleting it', () => {
  const moved = [
    '--- a/x.js',
    '+++ b/x.js',
    '-  const userPrefs = load();',
    '-  apply(userPrefs);',
    '+  const userPrefs = loadPreferences();',
    '+  apply(userPrefs);',
  ].join('\n');
  const r = checkIntentPreserved(task({ title: 'Fix userPrefs loading in the search route' }), moved);
  assert.equal(r.veto, false);
});

test('does not blame one task for another task in the same batch', () => {
  // A batch shares one diff. Scoping by declared files stops an honest cleanup in file A from
  // being charged to an unrelated additive task in file B.
  const plan = { tasks: [
    { title: 'Add userPrefs support to the ranker', files: ['backend/server/lib/rank.js'], rationale: '' },
    { title: 'Remove the dead personalisation block', files: ['backend/server/routes/search.js'], rationale: '' },
  ] };
  assert.equal(checkIntentPreserved(plan, SEARCH_DIFF).veto, false);
});

test('still fires when the task declared the very file it gutted', () => {
  const plan = { tasks: [{ title: 'Resolve the userPrefs TODO', files: ['backend/server/routes/search.js'], rationale: '' }] };
  assert.equal(checkIntentPreserved(plan, SEARCH_DIFF).veto, true);
});

test('ignores a removal of something the task never named', () => {
  const other = ['--- a/x.js', '+++ b/x.js', '-  log(unrelatedThing);'].join('\n');
  assert.equal(checkIntentPreserved(task({ title: 'Add userPrefs support' }), other).veto, false);
});

test('skips a task whose declared files are absent from the diff', () => {
  // It produced no change, so it has no intent to violate — and checking it against the whole diff
  // would charge it with whatever its neighbours did.
  const plan = { tasks: [{ title: 'Add userPrefs support', files: ['backend/server/lib/rank.js'], rationale: '' }] };
  assert.equal(checkIntentPreserved(plan, SEARCH_DIFF).veto, false);
});

test('says so when there is nothing to compare, rather than passing silently', () => {
  const r = checkIntentPreserved({ tasks: [] }, SEARCH_DIFF);
  assert.equal(r.checked, false);
  assert.equal(r.veto, false);
  assert.equal(checkIntentPreserved(null, null).checked, false);
});

test('namedIdentifiers picks out code names and leaves prose alone', () => {
  const names = namedIdentifiers('Resolve TODO in routes/search.js regarding userPrefs at line 45');
  assert.ok(names.includes('userPrefs'));
  for (const prose of ['Resolve', 'regarding', 'line', 'search']) assert.ok(!names.includes(prose), `${prose} is prose`);
});

test('countInDiff counts content lines, not file headers', () => {
  const d = ['--- a/userPrefs.js', '+++ b/userPrefs.js', '-const userPrefs = 1;', '+const other = 2;'].join('\n');
  assert.deepEqual(countInDiff(d, 'userPrefs'), { added: 0, removed: 1 });
});

test('countInDiff respects word boundaries', () => {
  const d = ['--- a/x.js', '+++ b/x.js', '-const userPrefsCache = 1;'].join('\n');
  assert.deepEqual(countInDiff(d, 'userPrefs'), { added: 0, removed: 0 });
});

test('a review below the floor is disqualifying on its own', () => {
  // #426 exactly: 55 with everything else near-perfect totalled 90 and committed.
  assert.match(reviewFloorVeto(55), /review veto/);
  assert.match(reviewFloorVeto(55), /below the floor/);
  assert.equal(reviewFloorVeto(70), null);
  assert.equal(reviewFloorVeto(95), null);
});

test('an unmeasured review is not treated as a failing one', () => {
  // A skipped phase must not read as a zero — that would roll back every run that never graded.
  assert.equal(reviewFloorVeto(null), null);
  assert.equal(reviewFloorVeto(undefined), null);
});

test('the floor is configurable', () => {
  assert.equal(reviewFloorVeto(65, { floor: 60 }), null);
  assert.match(reviewFloorVeto(65, { floor: 80 }), /below the floor of 80/);
});
