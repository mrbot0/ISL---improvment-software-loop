import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb, initCoreSchema, db } from '../src/db.js';
import { setProfile } from '../src/context/contextDb.js';
import { areasForFiles, briefingFor, briefingSnapshot } from '../src/context/fleetBriefing.js';

/**
 * THE KNOWLEDGE WAS THERE; IT NEVER REACHED THE DECISION.
 *
 * The Context Manager builds an accurate profile of the application, including invariants ("a
 * microservice outage must never block user access") and recorded risks ("assuming models that do
 * not exist causes runtime errors" — which describes, in advance, the change that later removed
 * business users from the target app).
 *
 * `projectContextBlurb()` was consumed by three modules: chat, the deploy manager and the
 * researcher. Not by the planner, which decides what to work on. Not by the reviewer, which decides
 * whether a change is right. These pin the distribution.
 */

const PROFILE = {
  whatItIs: 'A peer-to-peer rental marketplace with payments and trust/safety layers.',
  objective: 'Let people rent objects and spaces from each other safely.',
  stack: ['Node.js', 'React', 'Prisma', 'PostgreSQL'],
  architecture: 'A monolith being split into domain microservices behind a strangler fig.',
  areas: [
    { name: 'backend-monolith', path: 'backend/server', responsibility: 'Core API orchestration and routing' },
    { name: 'microservices', path: 'services', responsibility: 'Domain logic for identity, listings, payments' },
    { name: 'frontend', path: 'frontend/app', responsibility: 'React SPA' },
  ],
  keyFlows: ['Booking & Payments: escrow via Stripe Connect', 'User Authentication: 2FA and passkeys'],
  invariants: [
    'The API contract must never change; consumers must not know which side handles the logic.',
    'Microservice outages must never block user access; fallback to the monolith is mandatory.',
    'Migrations must use prisma migrate deploy; db push is forbidden in production.',
  ],
  risks: ['Assuming existence of models like ApiKey or Dispute which do not exist, causing runtime errors.'],
  glossary: [],
  docHighlights: [],
  summary: 'A marketplace mid-migration.',
};

before(() => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-brief-')), 'p.sqlite');
  openProjectDb(dbFile);
  initCoreSchema();
});

beforeEach(() => {
  setProfile(PROFILE);
});

test('the planner is told what the application is', () => {
  const b = briefingFor('planner', { includeSituation: false });
  assert.match(b, /peer-to-peer rental marketplace/);
  assert.match(b, /strangler fig/, 'the architecture matters when choosing where to work');
});

test('the planner is given the invariants as prohibitions', () => {
  const b = briefingFor('planner', { includeSituation: false });
  assert.match(b, /INVARIANTS/);
  assert.match(b, /must never block user access/);
  assert.match(b, /db push is forbidden/);
});

test('the planner is given the recorded risks', () => {
  // This exact risk describes the failure that removed business users from the app. The planner
  // had never been shown it.
  const b = briefingFor('planner', { includeSituation: false });
  assert.match(b, /KNOWN RISKS/);
  assert.match(b, /models like ApiKey or Dispute which do not exist/);
});

test('the reviewer is given the rules for the files in front of it', () => {
  const b = briefingFor('reviewer', { files: ['services/payments/src/hardening.js'], includeSituation: false });
  assert.match(b, /microservices/, 'the area the diff touches is named');
  assert.match(b, /Domain logic for identity/, 'with what that area is responsible for');
  assert.match(b, /INVARIANTS/);
});

test('the reviewer is not handed the whole tour', () => {
  // It is judging a diff, not choosing work. A block long enough to skim is a block that gets
  // skimmed, so the flows and the full area list stay out.
  const reviewer = briefingFor('reviewer', { files: ['frontend/app/x.jsx'], includeSituation: false });
  const planner = briefingFor('planner', { includeSituation: false });
  assert.ok(reviewer.length < planner.length, 'the reviewer block is the shorter one');
  assert.ok(!/KEY USER FLOWS/.test(reviewer));
});

test('a project with no profile yet contributes nothing rather than failing', () => {
  db.exec("DELETE FROM context_kv WHERE key = 'profile';");
  assert.equal(briefingFor('planner'), '');
  assert.equal(briefingFor('reviewer', { files: ['a.js'] }), '');
  assert.equal(briefingSnapshot().hasProfile, false);
});

test('areasForFiles maps a diff to the parts of the system it touches', () => {
  const areas = areasForFiles(['services/payments/src/x.js', 'frontend/app/y.jsx'], PROFILE);
  assert.deepEqual(areas.map((a) => a.name).sort(), ['frontend', 'microservices']);
});

test('the longest matching path wins', () => {
  // `services/...` must resolve to microservices, not to a shorter prefix that also matches.
  const p = { areas: [{ name: 'root', path: '' }, { name: 'microservices', path: 'services' }] };
  const areas = areasForFiles(['services/payments/src/x.js'], p);
  assert.equal(areas[0]?.name, 'microservices');
});

test('a file in no declared area yields no area rather than a wrong one', () => {
  assert.deepEqual(areasForFiles(['scripts/tool.sh'], PROFILE), []);
});

test('the snapshot reports what the briefing is built from', () => {
  const s = briefingSnapshot();
  assert.equal(s.hasProfile, true);
  assert.equal(s.counts.invariants, 3);
  assert.equal(s.counts.areas, 3);
  assert.ok(s.audiences.planner > s.audiences.reviewer);
});
