/**
 * Passa le ultime commit di un repo attraverso i gate deterministici di ISL.
 *
 * Domanda a cui risponde: queste commit possono rompere qualcosa? Non "il reviewer era contento" —
 * quello lo sappiamo già, ha approvato tutto. Le verifiche qui sono meccaniche e non hanno opinioni.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkScope } from '../src/iteration/scopeGate.js';
import { stripNonCode, duplicateClassMembers } from '../src/iteration/staticAnalysis.js';

const REPO = process.argv[2];
const N = Number(process.argv[3] || 10);
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const commits = git('log', '--format=%H|%s', `-${N}`).trim().split('\n').map((l) => {
  const [sha, ...rest] = l.split('|');
  return { sha, subject: rest.join('|') };
});

const report = [];
for (const c of commits) {
  const diff = git('show', '--format=', '--unified=3', c.sha);
  const files = git('show', '--format=', '--name-only', c.sha).trim().split('\n').filter(Boolean);

  // SCOPE: identificatori usati e mai legati, letti sullo stato ATTUALE dei file toccati.
  const scope = checkScope(diff, { root: REPO });

  // MEMBRI DUPLICATI: due metodi con lo stesso nome in una classe — il secondo vince in silenzio.
  const dupes = [];
  for (const f of files.filter((f) => /\.(js|jsx|mjs)$/.test(f))) {
    let src;
    try { src = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
    for (const d of duplicateClassMembers(stripNonCode(src))) dupes.push(`${f}: ${d.cls}.${d.name}`);
  }

  // SCHEMA: un campo Prisma aggiunto senza migrazione è una colonna che non esiste.
  const touchesSchema = files.some((f) => /schema\.prisma$/.test(f));
  const hasMigration = files.some((f) => /migrations?\//.test(f));

  // CATCH CHE INGOIA: `catch { }` o catch che ritorna un valore permissivo nel diff aggiunto.
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const swallow = added.filter((l) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(l)).length;

  report.push({
    sha: c.sha.slice(0, 8),
    subject: c.subject.slice(0, 72),
    fileJs: files.filter((f) => /\.(js|jsx|mjs)$/.test(f)).length,
    scope: scope.findings.map((f) => `${f.file.split('/').pop()}:${f.name}`),
    dupes,
    schemaSenzaMigrazione: touchesSchema && !hasMigration,
    catchVuoti: swallow,
  });
}

let problemi = 0;
for (const r of report) {
  const flags = [];
  if (r.scope.length) flags.push(`SCOPE(${r.scope.length}): ${r.scope.join(', ')}`);
  if (r.dupes.length) flags.push(`DUPLICATI: ${r.dupes.join(', ')}`);
  if (r.schemaSenzaMigrazione) flags.push('SCHEMA senza migrazione');
  if (r.catchVuoti) flags.push(`catch vuoti: ${r.catchVuoti}`);
  if (flags.length) problemi++;
  console.log(`${flags.length ? '✗' : '·'} ${r.sha}  ${r.subject}`);
  for (const f of flags) console.log(`     ${f}`);
}
console.log(`\n${report.length} commit esaminate · ${problemi} con segnalazioni`);
