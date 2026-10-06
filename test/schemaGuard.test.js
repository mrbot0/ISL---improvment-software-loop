import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedSchemaFields, checkSchemaMigrations, hasMigration } from '../src/iteration/schemaGuard.js';

/**
 * THE CHANGE THAT MADE BUSINESS USERS DISAPPEAR.
 *
 * Run #91 added `trustScore Int? @default(0)` to the `User` model in the listings service's schema —
 * a model whose own comment says it is a read-only mirror of a table the service does not own — and
 * added no migration. Review scored it 35, tests 0, security 55; the weighted total came to 63
 * against a rollback threshold of 60, and it committed.
 *
 * Every other gate was structurally blind to it. The file parses. It is not JavaScript, so no export
 * vanished. No suite touched it. And the app BOOTS, because Prisma validates a field against the
 * database only when a query runs — so the workbench gate saw a healthy service. The failure
 * surfaced much later, in production, as `column User.trustScore does not exist` on every read.
 */

const schemaDiff = (line) => ['--- a/services/listings/prisma/schema.prisma', '+++ b/services/listings/prisma/schema.prisma', line].join('\n');

test('vetoes the exact change that broke it', () => {
  const r = checkSchemaMigrations(schemaDiff('+  trustScore Int?    @default(0)'));
  assert.equal(r.veto, true);
  assert.equal(r.fields[0].field, 'trustScore');
  assert.match(r.summary, /no migration/);
  assert.match(r.summary, /fails at runtime/);
});

test('allows the same field when a migration comes with it', () => {
  const withMigration = [
    schemaDiff('+  trustScore Int?    @default(0)'),
    '--- /dev/null',
    '+++ b/services/listings/prisma/migrations/20260801_trust/migration.sql',
    '+ALTER TABLE "User" ADD COLUMN "trustScore" INTEGER DEFAULT 0;',
  ].join('\n');
  const r = checkSchemaMigrations(withMigration);
  assert.equal(r.veto, false);
  assert.match(r.summary, /with a migration/);
});

test('ignores relations, which have no column behind them', () => {
  // Requiring a migration for an association would fire on every legitimate schema change.
  assert.equal(checkSchemaMigrations(schemaDiff('+  owner       User     @relation(fields: [ownerId], references: [id])')).veto, false);
  assert.equal(checkSchemaMigrations(schemaDiff('+  items       Item[]')).veto, false);
  assert.equal(checkSchemaMigrations(schemaDiff('+  totpSecret  TotpSecret?')).veto, false);
});

test('ignores comments, attributes and block punctuation', () => {
  for (const line of ['+  // read-only mirror', '+  @@map("User")', '+}', '+model User {']) {
    assert.equal(addedSchemaFields(schemaDiff(line)).length, 0, line);
  }
});

test('ignores changes to files that are not schemas', () => {
  const js = ['--- a/src/x.js', '+++ b/src/x.js', '+  trustScore Int?    @default(0)'].join('\n');
  assert.equal(checkSchemaMigrations(js).veto, false);
});

test('does not fire on a removed field', () => {
  // Dropping a field is a different operation, and Prisma tolerates columns the model omits.
  assert.equal(checkSchemaMigrations(schemaDiff('-  trustScore Int?    @default(0)')).veto, false);
});

test('recognises every shape of migration', () => {
  assert.equal(hasMigration('', ['services/x/prisma/migrations/1_a/migration.sql']), true);
  assert.equal(hasMigration('', ['db/migrate/001_add_col.sql']), true);
  assert.equal(hasMigration('', ['scripts/backfill.sql']), true);
  assert.equal(hasMigration('', ['src/app.js']), false);
});

test('names every offending field, not just the first', () => {
  const two = [
    '--- a/a.prisma',
    '+++ b/a.prisma',
    '+  alpha  String',
    '+  beta   Int',
  ].join('\n');
  const r = checkSchemaMigrations(two);
  assert.equal(r.fields.length, 2);
  assert.match(r.summary, /alpha/);
  assert.match(r.summary, /beta/);
});

test('is quiet when a change touches no schema at all', () => {
  const r = checkSchemaMigrations(['--- a/x.js', '+++ b/x.js', '+const a = 1;'].join('\n'));
  assert.equal(r.veto, false);
  assert.equal(r.checked, true);
  assert.match(r.summary, /no schema fields added/);
});

test('survives empty input', () => {
  assert.equal(checkSchemaMigrations().veto, false);
  assert.equal(checkSchemaMigrations('', []).veto, false);
});

test('a re-indented model is not read as eleven new fields', () => {
  /*
   * Adding one long field name makes Prisma realign the whole block, so every line in the model
   * arrives as `-old` / `+new`. Run #91's real diff looked like this, and the first version of the
   * guard named `id`, `name` and `handle` as newly added alongside `trustScore`.
   */
  const realign = [
    '--- a/services/listings/prisma/schema.prisma',
    '+++ b/services/listings/prisma/schema.prisma',
    '-  id       String  @id',
    '-  name     String',
    '-  handle   String?',
    '+  id         String  @id',
    '+  name       String',
    '+  handle     String?',
    '+  trustScore Int?    @default(0)',
  ].join('\n');
  const fields = addedSchemaFields(realign).map((f) => f.field);
  assert.deepEqual(fields, ['trustScore'], 'only the genuinely new field counts');
});
