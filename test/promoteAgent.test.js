import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excludeWithDependents } from '../src/iteration/promoteAgent.js';

/**
 * Excluding a commit means excluding what builds on it.
 *
 * This is the rule that makes cherry-picking a subset safe to offer at all. Drop a commit and keep
 * something that depended on it and one of two things happens: git refuses, which is merely
 * annoying — or it applies, and the result compiles into behaviour nobody wrote, which is the
 * failure mode that would make an operator stop trusting promotion entirely.
 *
 * In the shipped path the closure is driven by git itself: a dependent that genuinely needed a
 * skipped commit fails to cherry-pick and is skipped in turn, so "it builds on X" is a fact rather
 * than an inference from file overlap. This function is the strict, pessimistic alternative, and it
 * still has to be correct — including in the case where a dependency is two hops away.
 */

const commits = (...shas) => shas.map((sha) => ({ sha }));
const graph = (pairs) => new Map(Object.entries(pairs).map(([k, v]) => [k, new Set(v)]));

test('a commit with no dependents excludes only itself', () => {
  const ordered = commits('a', 'b', 'c');
  const deps = graph({ a: [], b: [], c: [] });
  const out = excludeWithDependents(ordered, deps, new Map([['b', 'broken']]));
  assert.deepEqual([...out.keys()], ['b']);
});

test('a direct dependent goes with it, and says which one', () => {
  const ordered = commits('a', 'b');
  const deps = graph({ a: [], b: ['a'] });
  const out = excludeWithDependents(ordered, deps, new Map([['a', 'the security scan flagged it']]));
  assert.deepEqual([...out.keys()].sort(), ['a', 'b']);
  // "excluded because it builds on a" is actionable; a bare "excluded" is not.
  assert.match(out.get('b'), /builds on a/);
  assert.match(out.get('b'), /security scan/);
});

test('THE TRANSITIVE CASE: a dependency two hops away still excludes', () => {
  /*
   * c does not touch a at all — it only builds on b, which builds on a. Stopping at direct
   * dependents would keep c, whose foundation is not there. This is precisely the case a single
   * pass over the list misses, which is why the closure iterates to a fixed point.
   */
  const ordered = commits('a', 'b', 'c');
  const deps = graph({ a: [], b: ['a'], c: ['b'] });
  const out = excludeWithDependents(ordered, deps, new Map([['a', 'broken']]));
  assert.deepEqual([...out.keys()].sort(), ['a', 'b', 'c']);
  assert.match(out.get('c'), /builds on b/);
});

test('an independent commit after a broken one is kept', () => {
  // The whole point. A fast-forward would have discarded d for being downstream in TIME; it is only
  // discarded here if it is downstream in DEPENDENCY.
  const ordered = commits('a', 'b', 'c', 'd');
  const deps = graph({ a: [], b: ['a'], c: [], d: ['c'] });
  const out = excludeWithDependents(ordered, deps, new Map([['a', 'broken']]));
  assert.deepEqual([...out.keys()].sort(), ['a', 'b']);
  assert.ok(!out.has('c') && !out.has('d'));
});

test('several broken commits close together', () => {
  const ordered = commits('a', 'b', 'c', 'd', 'e');
  const deps = graph({ a: [], b: ['a'], c: [], d: ['c'], e: ['b', 'd'] });
  const out = excludeWithDependents(ordered, deps, new Map([['a', 'x'], ['c', 'y']]));
  assert.deepEqual([...out.keys()].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('nothing broken excludes nothing', () => {
  const ordered = commits('a', 'b', 'c');
  const deps = graph({ a: [], b: ['a'], c: ['b'] });
  assert.equal(excludeWithDependents(ordered, deps, new Map()).size, 0);
});

test('a dependency on a commit that is not in the list is ignored', () => {
  // The range starts somewhere; a reference to a commit already on the base branch is not a reason
  // to drop anything.
  const ordered = commits('b', 'c');
  const deps = graph({ b: ['already-on-main'], c: ['b'] });
  assert.equal(excludeWithDependents(ordered, deps, new Map()).size, 0);
});

test('it terminates on a graph with a cycle', () => {
  // Real history cannot produce one, but a bug in the graph builder could, and a fixed-point loop
  // that never reaches a fixed point would hang the request rather than fail it.
  const ordered = commits('a', 'b');
  const deps = graph({ a: ['b'], b: ['a'] });
  const out = excludeWithDependents(ordered, deps, new Map([['a', 'broken']]));
  assert.deepEqual([...out.keys()].sort(), ['a', 'b']);
});
