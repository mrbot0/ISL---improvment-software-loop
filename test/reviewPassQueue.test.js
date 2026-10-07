import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb, db } from '../src/db.js';
import { setSetting, upsertAgent } from '../src/db.js';
import { WORKER_ID, enqueue as enqueueJob } from '../src/core/workQueue.js';
import { Orchestrator } from '../src/orchestrator.js';

/**
 * LA CODA DELLE PASSATE DI REVISIONE SOPRAVVIVE AL PROCESSO.
 *
 * `this.queue` era un array in memoria. Il supervisore riavvia il server dopo ogni
 * crash e dopo ogni riavvio pulito del guardiano: a ogni riavvio la coda spariva
 * senza lasciare traccia, e chi l'aveva riempita non lo sapeva. Questi test fissano
 * le tre proprietà che rendono il meccanismo adatto a un piano di controllo che deve
 * restare acceso per giorni:
 *
 *   1. un lavoro messo in coda è una riga di SQLite, e un processo NUOVO lo esegue;
 *   2. un lavoro interrotto a metà esce dallo stato "in esecuzione" — il lease scade
 *      e viene recuperato — mentre uno ancora tenuto da un worker VIVO non si ruba;
 *   3. i ritentativi hanno un tetto: dopo `maxAttempts` il lavoro è `dead` e nessun
 *      giro successivo lo riprende. Un errore permanente non deve poter consumare
 *      budget per sempre nascondendo il guasto.
 */

const AGENT = 'test-reviewer';
const ROLE = 'review-pass';
const KIND = 'review_pass';

let dbFile;
const live = [];

/** Un'istanza che non si muove da sola: il poll e i rinnovi restano fermi. */
const makeOrchestrator = (deps = {}) => {
  const o = new Orchestrator({
    headCommit: () => 'c0ffee',
    verifyProposal: async () => {},
    retryDelayMs: 0,
    ...deps,
  });
  live.push(o);
  return o;
};

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-revq-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
  upsertAgent({ id: AGENT, name: 'Reviewer', objective: 'review', systemPrompt: 'review' });
});

after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbFile + s, { force: true });
    } catch {
      /* held by the OS on Windows */
    }
  }
});

beforeEach(() => {
  db.exec('DELETE FROM work_queue');
  db.prepare('DELETE FROM leadership WHERE role = ?').run(ROLE);
  setSetting('reviewPassMaxAttempts', 2);
});

afterEach(() => {
  while (live.length) live.pop().stopPolling();
});

/** Riga della coda per id. */
const row = (id) => db.prepare('SELECT * FROM work_queue WHERE id = ?').get(id);
const rows = () => db.prepare('SELECT * FROM work_queue WHERE kind = ? ORDER BY id').all(KIND);

/** Mette in coda un lavoro come lo scrive `enqueue`, senza far partire nessuno. */
const plant = ({ agentId = AGENT, maxAttempts = 2, instruction = null } = {}) =>
  enqueueJob({ kind: KIND, payload: { agentId, trigger: 'manual', instruction }, maxAttempts }).id;

/** Un holder sulla QUESTA macchina con un pid vivo: il ruolo non è riscattabile. */
const liveForeignWorker = () => `${os.hostname()}:${process.pid}:other`;

const plantLease = (jobId, { holder, leaseUntil }) =>
  db
    .prepare("UPDATE work_queue SET status = 'leased', leased_by = ?, lease_until = ? WHERE id = ?")
    .run(holder, leaseUntil, jobId);

test('enqueue writes a durable row, and a NEW instance (a restart) runs it', async () => {
  // Un altro worker VIVO tiene il ruolo: chi mette in coda non può eseguire nulla.
  // È il modo pulito di ottenere un lavoro "in coda e mai partito".
  db.prepare('INSERT INTO leadership (role, holder, lease_until, since) VALUES (?, ?, ?, ?)')
    .run(ROLE, liveForeignWorker(), Date.now() + 600_000, Date.now());

  let ranOnFirst = 0;
  const first = makeOrchestrator({ runAgent: async () => (ranOnFirst++, { runId: 1, proposalIds: [] }) });
  const r = first.enqueue(AGENT, { trigger: 'manual', instruction: 'audit the auth surface' });

  assert.equal(r.queued, true);
  assert.equal(r.position, 1);
  assert.ok(r.jobId > 0, 'the queued job must have a durable identity');
  await first.drain();
  assert.equal(ranOnFirst, 0, 'the role is held elsewhere — nothing may run here');
  assert.equal(row(r.jobId).status, 'ready', 'the request must be waiting in SQLite, not in an array');

  // Lo stato deve dire a un operatore cosa sta aspettando e perché.
  const s = first.state();
  assert.deepEqual(s.queued, [AGENT], 'the legacy shape the dashboard reads must survive');
  assert.equal(s.durable.counts.ready, 1);
  assert.equal(s.durable.waiting[0].instruction, 'audit the auth surface');
  assert.equal(s.durable.leadership.isMe, false);
  assert.ok(s.durable.leadership.holder, 'an operator must be able to see WHO is holding the role');

  // Il processo che aveva la coda è finito. Il successore la trova.
  db.prepare('DELETE FROM leadership WHERE role = ?').run(ROLE);
  let ranOnSecond = 0;
  const second = makeOrchestrator({ runAgent: async () => (ranOnSecond++, { runId: 2, proposalIds: [] }) });
  await second.drain();

  assert.equal(ranOnSecond, 1, 'a queued review pass must survive the restart and run');
  assert.equal(row(r.jobId).status, 'done');
});

test('a job interrupted mid-run leaves the running state once its lease lapses', async () => {
  const id = plant();
  plantLease(id, { holder: 'crashed-host:4242:dead', leaseUntil: Date.now() - 1_000 });

  let ran = 0;
  const o = makeOrchestrator({ runAgent: async () => (ran++, { runId: 3, proposalIds: [] }) });
  await o.drain();

  assert.equal(ran, 1, 'a lapsed lease means its worker died — the job must be taken up again');
  assert.equal(row(id).status, 'done', 'it must not stay "leased" for ever');
});

test('a job still held by a LIVE worker is reported, not stolen', async () => {
  const id = plant();
  const until = Date.now() + 600_000;
  plantLease(id, { holder: liveForeignWorker(), leaseUntil: until });

  let ran = 0;
  const o = makeOrchestrator({ runAgent: async () => (ran++, { runId: 4, proposalIds: [] }) });
  await o.drain();

  assert.equal(ran, 0, 'running someone else’s in-flight job would duplicate the whole pass');
  assert.equal(row(id).status, 'leased');

  const orphaned = o.state().durable.orphaned;
  assert.equal(orphaned.length, 1, 'an operator must see the job that is held elsewhere');
  assert.equal(orphaned[0].id, id);
  assert.equal(orphaned[0].mine, false);
  assert.equal(orphaned[0].reclaimAt, until, 'and when it will be reclaimed');
});

test('retries are capped: after maxAttempts the job is dead and no later drain revives it', async () => {
  setSetting('reviewPassMaxAttempts', 2);
  const id = plant({ maxAttempts: 2 });

  let attempts = 0;
  const o = makeOrchestrator({
    runAgent: async () => {
      attempts += 1;
      throw new Error('ollama is down');
    },
  });
  await o.drain();

  assert.equal(attempts, 2, 'exactly the cap — not one more, not for ever');
  const r = row(id);
  assert.equal(r.status, 'dead');
  assert.equal(r.attempts, 2);
  assert.match(r.last_error, /ollama is down/);

  await o.drain();
  assert.equal(attempts, 2, 'a dead job must never be picked up again');

  const failures = o.state().durable.recentFailures;
  assert.equal(failures[0].id, id);
  assert.equal(failures[0].status, 'dead');
  assert.equal(failures[0].retriable, false);
  assert.match(failures[0].error, /ollama is down/);
});

test('the cap is clamped: a bogus setting cannot buy unlimited retries', async () => {
  const o = makeOrchestrator({ runAgent: async () => ({ runId: 5, proposalIds: [] }) });

  setSetting('reviewPassMaxAttempts', 9999);
  assert.equal(o.maxAttempts, 5, 'the cap has a ceiling of its own');
  setSetting('reviewPassMaxAttempts', 0);
  assert.equal(o.maxAttempts, 1, 'and a floor of one attempt');
  setSetting('reviewPassMaxAttempts', 'plenty');
  assert.equal(o.maxAttempts, 2, 'nonsense falls back to the default');

  o.setMaxAttempts(50);
  assert.equal(o.maxAttempts, 5);
});

test('a permanently broken job is settled at once instead of burning its attempts', async () => {
  const id = plant({ agentId: 'deleted-specialist', maxAttempts: 3 });

  let ran = 0;
  const o = makeOrchestrator({ runAgent: async () => (ran++, { runId: 6, proposalIds: [] }) });
  await o.drain();

  assert.equal(ran, 0);
  const r = row(id);
  assert.equal(r.attempts, 1, 'no agent will appear on a second or third try');
  assert.equal(JSON.parse(r.result_json).ok, false);

  const failures = o.state().durable.recentFailures;
  assert.equal(failures.length, 1, 'a settled failure must still be visible as a failure');
  assert.match(failures[0].error, /unknown agent/);
});

test('a cancelled pass is not retried', async () => {
  const id = plant({ maxAttempts: 3 });

  let ran = 0;
  const o = makeOrchestrator({
    runAgent: async () => {
      ran += 1;
      const r = o.cancelCurrent();
      assert.equal(r.cancelled, true);
      assert.equal(r.agentId, AGENT);
      throw new Error('aborted');
    },
  });
  await o.drain();

  assert.equal(ran, 1, 'retrying would redo exactly what a human asked to stop');
  assert.equal(JSON.parse(row(id).result_json).reason, 'cancelled by operator');
  await o.drain();
  assert.equal(ran, 1);
});

test('a successful pass verifies its proposals and a failing check does not fail the job', async () => {
  const id = plant();
  const verified = [];
  const o = makeOrchestrator({
    runAgent: async () => ({ runId: 11, proposalIds: [101, 102], steps: 3 }),
    verifyProposal: async (pid) => {
      verified.push(pid);
      if (pid === 102) throw new Error('sandbox unavailable');
    },
  });
  await o.drain();

  assert.deepEqual(verified, [101, 102]);
  const r = row(id);
  assert.equal(r.status, 'done');
  const result = JSON.parse(r.result_json);
  assert.equal(result.ok, true);
  assert.equal(result.proposals, 2);
  assert.equal(o.state().durable.recentFailures.length, 0, 'a verification error is not a queue failure');
});

test('an idempotency key makes a repeated request one job, not two', async () => {
  db.prepare('INSERT INTO leadership (role, holder, lease_until, since) VALUES (?, ?, ?, ?)')
    .run(ROLE, liveForeignWorker(), Date.now() + 600_000, Date.now());

  const o = makeOrchestrator({ runAgent: async () => ({ runId: 12, proposalIds: [] }) });
  const a = o.enqueue(AGENT, { idempotencyKey: 'nightly-security-audit' });
  const b = o.enqueue(AGENT, { idempotencyKey: 'nightly-security-audit' });

  assert.equal(b.jobId, a.jobId);
  assert.equal(b.duplicate, true);
  assert.equal(rows().length, 1);
});

test('enqueue still refuses an unknown agent, before anything is written', () => {
  assert.throws(() => makeOrchestrator().enqueue('nobody'), /Unknown agent/);
  assert.equal(rows().length, 0);
});

test('state() survives a queue it cannot read', () => {
  const o = makeOrchestrator();
  db.exec('DROP TABLE work_queue');
  try {
    const s = o.state();
    assert.deepEqual(s.queued, []);
    assert.deepEqual(s.durable.waiting, []);
    assert.equal(s.durable.worker, WORKER_ID);
  } finally {
    // La ricrea per i test successivi: lo schema è registrato, basta riaprire.
    openProjectDb(dbFile);
    initCoreSchema();
    upsertAgent({ id: AGENT, name: 'Reviewer', objective: 'review', systemPrompt: 'review' });
  }
});
