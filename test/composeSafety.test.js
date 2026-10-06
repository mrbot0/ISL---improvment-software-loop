import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNonDestructive, serviceArg } from '../src/runtime/compose.js';

/**
 * THE RUNTIME MUST NOT BE ABLE TO DESTROY THE DATABASE.
 *
 * `docker compose down -v` removes the named volumes, and Postgres lives in one. Losing it means
 * losing every row — users, listings, bookings — with no undo and no warning beyond a line of
 * compose output that scrolls past. Everything else the runtime does is recoverable; this is not.
 *
 * There are two layers, and both are tested: a guard that refuses the flag at call time, and a
 * check over the source itself, so a future edit that adds `-v` to a command fails here rather than
 * in someone's data.
 */

test('refuses the flag that deletes volumes', () => {
  assert.throws(() => assertNonDestructive(['down', '-v']), /delete the database volume/);
  assert.throws(() => assertNonDestructive(['down', '--volumes']), /delete the database volume/);
  assert.throws(() => assertNonDestructive(['down', '--remove-orphans']), /delete the database volume/);
});

test('allows the commands the runtime actually needs', () => {
  for (const args of [['stop', 'payments'], ['start', 'payments'], ['restart', 'payments'], ['up', '-d', '--build', 'payments'], ['ps', '--format', 'json']]) {
    assert.deepEqual(assertNonDestructive(args), args);
  }
});

test('a service name cannot smuggle in a flag', () => {
  // The name reaches docker as a positional argument. Without this, a crafted name could turn
  // `stop <name>` into `stop -v`, which is precisely what the guard above exists to prevent.
  for (const bad of ['-v', '--volumes', '', '  ', null, undefined, 'a b', '$(rm -rf /)', '--rm']) {
    assert.throws(() => serviceArg(bad), /invalid service name/, JSON.stringify(bad));
  }
});

test('ordinary compose service names are accepted', () => {
  for (const good of ['payments', 'listings-1', 'search_v2', 'db.primary', 'redis']) {
    assert.equal(serviceArg(good), good);
  }
});

test('no command in compose.js carries a volume-destroying flag', () => {
  /*
   * A source-level check, not a unit test of a function. The guard only helps where a caller
   * remembers to use it; this catches the case where someone adds a new command and does not.
   */
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'compose.js'),
    'utf8',
  );
  // Every literal argument array handed to `compose(...)`.
  const offenders = [];
  for (const m of src.matchAll(/compose\(\s*target\s*,\s*(?:assertNonDestructive\()?\[([^\]]*)\]/g)) {
    const args = m[1];
    if (/'-v'|"-v"|'--volumes'|"--volumes"/.test(args)) offenders.push(args.trim());
  }
  assert.deepEqual(offenders, [], `these commands would delete a volume: ${offenders.join(' | ')}`);
});

test('stopping one service uses stop, not down', () => {
  // `down` tears down the whole project. Restarting one container is not a reason to do that to
  // Postgres and everything else that happens to be healthy.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'compose.js'),
    'utf8',
  );
  const stopService = /export const stopService[\s\S]*?;\n/.exec(src)?.[0] || '';
  assert.match(stopService, /'stop'/);
  assert.ok(!/'down'/.test(stopService), 'stopService must not use down');
});
