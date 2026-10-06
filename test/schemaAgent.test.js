import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrismaModels } from '../src/runtime/schemaAgent.js';

/**
 * The integrity agent compares each Prisma model against the columns the database actually has.
 * Everything it concludes rests on this parser, so the parser is what is pinned here — a model read
 * wrongly either invents drift (and the check gets ignored) or misses the real thing.
 *
 * The case it exists for is run #91: `trustScore Int? @default(0)` added to a `User` model mapped to
 * a table that has never had that column. Prisma only checks a field against the table when a query
 * runs, so the schema parsed, the service booted, every gate passed — and every `User` read from
 * that service failed in production.
 */

const SCHEMA = `
model Item {
  id          String   @id @default(uuid())
  title       String
  priceCents  Int
  ownerId     String
  owner       User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now())
}

// Read-only: per comporre l'owner nella risposta di create.
model User {
  id         String  @id
  name       String
  handle     String?
  avatarUrl  String?
  verified   Boolean @default(false)
  rating     Float   @default(0)
  trustScore Int?    @default(0)
  items      Item[]

  @@map("User")
}
`;

test('reads models, their fields and the table they map to', () => {
  const models = parsePrismaModels(SCHEMA);
  assert.deepEqual(models.map((m) => m.model), ['Item', 'User']);
  const user = models.find((m) => m.model === 'User');
  assert.equal(user.table, 'User', '@@map names the real table');
  assert.ok(user.fields.some((f) => f.field === 'trustScore'), 'the field that broke it must be seen');
});

test('a model with no @@map is its own table name', () => {
  assert.equal(parsePrismaModels(SCHEMA).find((m) => m.model === 'Item').table, 'Item');
});

test('skips relations, which have no column behind them', () => {
  // `owner` and `items` are resolved through foreign keys. Reporting them as missing columns would
  // bury the one real finding under a dozen false ones — and that is how a check gets switched off.
  const fields = parsePrismaModels(SCHEMA).flatMap((m) => m.fields.map((f) => f.field));
  assert.ok(!fields.includes('owner'), 'a single relation is not a column');
  assert.ok(!fields.includes('items'), 'a list relation is not a column');
  assert.ok(fields.includes('ownerId'), 'but the foreign key itself is');
});

test('follows @map to the column name the database actually uses', () => {
  const m = parsePrismaModels('model A {\n  createdAt DateTime @map("created_at")\n}')[0];
  assert.equal(m.fields[0].field, 'createdAt');
  assert.equal(m.fields[0].column, 'created_at', 'the database is asked about the mapped name');
});

test('ignores comments and block attributes', () => {
  const m = parsePrismaModels('model A {\n  // a note\n  id String @id\n  @@index([id])\n}')[0];
  assert.deepEqual(m.fields.map((f) => f.field), ['id']);
});

test('records optionality without treating it as absence', () => {
  // `trustScore Int?` is optional in Prisma's sense — the COLUMN must still exist.
  const user = parsePrismaModels(SCHEMA).find((m) => m.model === 'User');
  assert.equal(user.fields.find((f) => f.field === 'trustScore').optional, true);
  assert.equal(user.fields.find((f) => f.field === 'name').optional, false);
});

test('handles every scalar Prisma offers', () => {
  const src = 'model A {\n' + ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']
    .map((t, i) => `  f${i} ${t}`).join('\n') + '\n}';
  assert.equal(parsePrismaModels(src)[0].fields.length, 9);
});

test('returns nothing for a file with no models rather than throwing', () => {
  assert.deepEqual(parsePrismaModels('generator client {\n  provider = "prisma-client-js"\n}'), []);
  assert.deepEqual(parsePrismaModels(''), []);
  assert.deepEqual(parsePrismaModels(), []);
});
