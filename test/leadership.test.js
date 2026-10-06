import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, closeProjectDb, db } from '../src/db.js';
import { acquireLeadership, leadershipStatus, releaseLeadership, WORKER_ID } from '../src/core/workQueue.js';

/**
 * Leader election, and the stall it used to cause.
 *
 * One loop drives one work branch, so a second one would interleave commits nobody could untangle —
 * the lease exists for a real reason and must not be loosened. But expiry ALONE meant that a server
 * which crashed or was killed kept the role for the full fifteen-minute TTL, and the successor stood
 * by with a log line naming a pid that no longer existed.
 *
 * That is not hypothetical: it is exactly why iterations stopped starting after a restart, diagnosed
 * from a lease row holding a dead pid with 5.6 minutes still to run.
 */

const ROLE = 'test-role';
let dbFile;

before(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-lease-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

after(() => {
  closeProjectDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbFile + s, { force: true }); } catch { /* held */ } }
});

beforeEach(() => { db.prepare('DELETE FROM leadership WHERE role = ?').run(ROLE); });

/** Plant a lease with a chosen holder, valid for another ten minutes. */
const plant = (holder) => {
  const until = Date.now() + 600_000;
  db.prepare('INSERT INTO leadership (role, holder, lease_until, since) VALUES (?, ?, ?, ?)')
    .run(ROLE, holder, until, Date.now());
};

/** A pid high enough to be unused. Verified unused rather than assumed. */
const deadPid = () => {
  for (const n of [999999, 999998, 999997]) {
    try { process.kill(n, 0); } catch (e) { if (e.code === 'ESRCH') return n; }
  }
  throw new Error('could not find an unused pid to test with');
};

test('a free role is taken immediately', () => {
  assert.equal(acquireLeadership(ROLE, 60_000), true);
  assert.equal(leadershipStatus(ROLE).isMe, true);
});

test('a live holder on this host keeps the role', () => {
  // This process is unquestionably alive, so its lease must be respected even though the pid is
  // one we can see. Getting this wrong is the failure that puts two loops on one branch.
  plant(`${os.hostname()}:${process.pid}:deadbeef`);
  assert.equal(acquireLeadership(ROLE, 60_000), false);
});

test('a DEAD holder on this host is reclaimed without waiting out the TTL', () => {
  plant(`${os.hostname()}:${deadPid()}:deadbeef`);
  const before = leadershipStatus(ROLE);
  assert.ok(before.leaseUntil > Date.now() + 500_000, 'the planted lease must still be far from expiry');

  assert.equal(acquireLeadership(ROLE, 60_000), true, 'a crashed leader must not hold the loop for 15 minutes');
  assert.equal(leadershipStatus(ROLE).isMe, true);
});

test('a holder on ANOTHER host is never reclaimed', () => {
  // We cannot ask another machine about its processes, so the only safe answer is to wait. A
  // multi-host deployment must never have one host deciding another's leader is gone.
  plant(`some-other-machine:${deadPid()}:deadbeef`);
  assert.equal(acquireLeadership(ROLE, 60_000), false);
});

test('an unparseable holder is left alone', () => {
  for (const junk of ['', 'garbage', 'host-only', `${os.hostname()}:notanumber:x`, `${os.hostname()}:-1:x`]) {
    db.prepare('DELETE FROM leadership WHERE role = ?').run(ROLE);
    plant(junk);
    assert.equal(acquireLeadership(ROLE, 60_000), false, `"${junk}" should not be treated as a dead process`);
  }
});

test('an expired lease is taken by whoever asks, as before', () => {
  db.prepare('INSERT INTO leadership (role, holder, lease_until, since) VALUES (?, ?, ?, ?)')
    .run(ROLE, `${os.hostname()}:${process.pid}:other`, Date.now() - 1000, Date.now() - 60_000);
  assert.equal(acquireLeadership(ROLE, 60_000), true);
});

test('the holder renews its own lease rather than losing it', () => {
  assert.equal(acquireLeadership(ROLE, 60_000), true);
  const first = leadershipStatus(ROLE).leaseUntil;
  assert.equal(acquireLeadership(ROLE, 120_000), true, 'a busy leader must keep the role it holds');
  assert.ok(leadershipStatus(ROLE).leaseUntil > first);
});

test('a clean release hands the role straight over', () => {
  acquireLeadership(ROLE, 60_000);
  assert.equal(releaseLeadership(ROLE), true);
  assert.equal(leadershipStatus(ROLE).holder, null);
});

test('WORKER_ID carries the host and pid the reclaim check needs', () => {
  // The reclaim is only possible because the identity is structured. If this format ever changes,
  // the check silently degrades to expiry-only and the stall comes back.
  const [host, pid] = WORKER_ID.split(':');
  assert.equal(host, os.hostname());
  assert.equal(Number(pid), process.pid);
});
