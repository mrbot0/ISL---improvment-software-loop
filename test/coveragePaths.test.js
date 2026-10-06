import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLcovLines, parseGoProfileLines, relativize } from '../src/iteration/coverageRun.js';

/**
 * THE PATH KEYS, WHICH IS WHERE THE COVERAGE GATE SILENTLY BROKE.
 *
 * A runner executes inside its own project directory, so its report names files relative to THAT —
 * `app/components/OfferDialog.jsx`. The changed lines come from a diff, which names them relative to
 * the REPO — `frontend/app/components/OfferDialog.jsx`. Key the two differently and the intersection
 * is always empty: the gate reads a full coverage report and then reports that the suite "never
 * loaded" the very file it just measured.
 *
 * It survived the first round of testing because the fixture had its project AT the repo root, where
 * the two conventions coincide. Every real monorepo is the case that fails. Caught only by running
 * the gate against an actual run: 171 files of per-line data read, zero of them matching.
 */

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-cov-')); });
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* held */ } });

const writeLcov = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

test('LCOV paths relative to the run directory stay relative to it', () => {
  const f = writeLcov('rel.info', ['SF:app/components/OfferDialog.jsx', 'DA:100,0', 'DA:101,3', 'end_of_record', ''].join('\n'));
  const out = parseLcovLines(f, path.join(dir, 'frontend'));
  assert.deepEqual([...out.keys()], ['app/components/OfferDialog.jsx']);
  assert.equal(out.get('app/components/OfferDialog.jsx').get(100), 0);
  assert.equal(out.get('app/components/OfferDialog.jsx').get(101), 3);
});

test('ABSOLUTE LCOV paths resolve against the project dir, not the repo root', () => {
  /*
   * The critical case. Given the sandbox root as the base, an absolute path yields
   * `frontend/app/x.js`; given the project dir it yields `app/x.js`. The caller prefixes the project
   * dir back on, so BOTH report styles end up keyed identically — which is the only way one
   * intersection can serve a repo-root project and a subdirectory project alike.
   */
  const project = path.join(dir, 'frontend');
  const abs = path.join(project, 'app', 'x.js');
  const f = writeLcov('abs.info', [`SF:${abs}`, 'DA:5,1', 'end_of_record', ''].join('\n'));

  const viaProject = parseLcovLines(f, project);
  assert.deepEqual([...viaProject.keys()], ['app/x.js'], 'relative to the project the runner ran in');

  // And re-prefixing gets back to what the diff speaks.
  const repoRelative = `frontend/${[...viaProject.keys()][0]}`;
  assert.equal(repoRelative, 'frontend/app/x.js');
});

test('a file outside the project is dropped, not mis-keyed', () => {
  // A dependency or a generated file must not become a phantom entry that never matches anything.
  const f = writeLcov('outside.info', [`SF:${path.join(dir, 'elsewhere', 'y.js')}`, 'DA:1,1', 'end_of_record', ''].join('\n'));
  assert.equal(parseLcovLines(f, path.join(dir, 'frontend')).size, 0);
});

test('node_modules never enters the coverage map', () => {
  const f = writeLcov('nm.info', ['SF:node_modules/lib/index.js', 'DA:1,1', 'end_of_record', ''].join('\n'));
  assert.equal(parseLcovLines(f, dir).size, 0);
});

test('two records for one file merge by MAX — exercised anywhere is exercised', () => {
  const f = writeLcov('dup.info', [
    'SF:app/x.js', 'DA:1,0', 'DA:2,0', 'end_of_record',
    'SF:app/x.js', 'DA:1,4', 'DA:2,0', 'end_of_record', '',
  ].join('\n'));
  const m = parseLcovLines(f, dir).get('app/x.js');
  assert.equal(m.get(1), 4);
  assert.equal(m.get(2), 0);
});

test('the Go profile keys the same way', () => {
  const p = path.join(dir, 'cover.out');
  fs.writeFileSync(p, ['mode: set', 'pkg/svc/handler.go:10.20,12.3 2 1', 'pkg/svc/handler.go:14.2,16.3 2 0', ''].join('\n'));
  const out = parseGoProfileLines(p, dir);
  const m = out.get('pkg/svc/handler.go');
  assert.ok(m, 'the file must be keyed relative to the base');
  assert.equal(m.get(10), 1);
  assert.equal(m.get(14), 0);
});

test('relativize is case-insensitive about the drive letter, as Windows is', () => {
  // Windows reports the same path with either case of drive letter depending on who produced it;
  // a case-sensitive compare would silently drop every file on that platform.
  assert.equal(relativize('C:/Repo/app/x.js', 'c:/repo'), 'app/x.js');
  assert.equal(relativize('c:/repo/app/x.js', 'C:/Repo'), 'app/x.js');
});

test('a malformed record does not throw', () => {
  const f = writeLcov('junk.info', ['not lcov at all', 'DA:1,1', 'SF:', 'end_of_record', ''].join('\n'));
  assert.doesNotThrow(() => parseLcovLines(f, dir));
});
