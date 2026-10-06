import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, db } from '../src/db.js';
import { finishTask, getKpi, startIteration, startTask } from '../src/db_iteration.js';
import { Semaphore } from '../src/core/semaphore.js';

/**
 * TWO DEFECTS THAT MADE THE LOOP LOOK WORSE THAN IT WAS.
 *
 * Measured over 420 recorded task failures:
 *
 *   216 were `fetch failed` — and **105 of the 109 iterations that hit it lost exactly two
 *       tasks**, with task parallelism set to two. Two concurrent generations against one local
 *       Ollama holding one resident model kill each other, on average 154 seconds in. The share of
 *       failures that were `fetch failed` rose from 37% to 72% as parallelism was used more, so
 *       retrying made it worse rather than better: the retry re-enters the same contention.
 *
 *   154 had no recorded reason at all. Not because none was known — the implementer computes a
 *       specific one ("finished without editing any file after N steps") — but because it was
 *       written to `summary` while `engine.js` records `result.error`.
 *
 * The second is the more corrosive of the two: the deferral that retires a hopeless target, the
 * clustering that groups recurring failures, and the memory that turns them into lessons all key
 * off that field. A third of the fleet's failures were invisible to every one of them.
 */

before(() => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-stab-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

beforeEach(() => {
  db.exec('DELETE FROM tasks; DELETE FROM iterations;');
});

test('the model is serialised by default, whatever task parallelism is set to', () => {
  // The knob that matters is separate now. One generation at a time unless an operator, running a
  // server that genuinely handles concurrency, says otherwise.
  const kpi = getKpi();
  assert.equal(kpi.max_parallel_llm, 1, 'default model concurrency');
  assert.ok(kpi.max_parallel_tasks >= 1, 'tasks still run in parallel');
});

test('a semaphore of one admits a second caller only after the first releases', async () => {
  const gate = new Semaphore(1, 'test');
  const order = [];
  const slow = gate.run(async () => { order.push('a:start'); await new Promise((r) => setTimeout(r, 30)); order.push('a:end'); });
  const fast = gate.run(async () => { order.push('b:start'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start'], 'the second generation waits for the first');
});

test('raising the limit lets a queued caller through', async () => {
  const gate = new Semaphore(1, 'test');
  let released = false;
  const first = gate.run(async () => { await new Promise((r) => setTimeout(r, 40)); released = true; });
  const second = gate.run(async () => released);
  gate.setLimit(2);
  const ranBeforeFirstFinished = await second;
  await first;
  assert.equal(ranBeforeFirstFinished, false, 'widening the gate admits the waiter immediately');
});

test('a failed task records a reason, not NULL', () => {
  const iter = startIteration('test', 'abc');
  const id = startTask(iter, { kind: 'improvement', title: 'do a thing', agent: 'quality' });
  // Exactly what the implementer now returns when it produced no edit.
  const reason = 'the implementer finished without editing any file (it could not turn the task into a concrete change after 6 step(s))';
  finishTask(id, 'failed', reason, [], reason);

  const row = db.prepare('SELECT status, error, summary FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.ok(row.error, 'a failure with no reason is invisible to clustering, deferral and memory');
  assert.match(row.error, /without editing any file/);
});

test('a successful task records no error', () => {
  const iter = startIteration('test', 'abc');
  const id = startTask(iter, { kind: 'improvement', title: 'ok', agent: 'quality' });
  finishTask(id, 'done', 'edited 2 files', ['a.js', 'b.js'], null);
  const row = db.prepare('SELECT error FROM tasks WHERE id = ?').get(id);
  assert.equal(row.error, null);
});

test('failure reasons can be grouped, which is what clustering needs', () => {
  const iter = startIteration('test', 'abc');
  const reason = 'fetch failed';
  for (let n = 0; n < 3; n++) {
    const id = startTask(iter, { kind: 'improvement', title: `t${n}`, agent: 'frontend' });
    finishTask(id, 'failed', reason, [], reason);
  }
  const rows = db.prepare("SELECT error, COUNT(*) n FROM tasks WHERE status = 'failed' GROUP BY error").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 3);
});
