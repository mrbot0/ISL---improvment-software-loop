/**
 * A FIELD ADDED TO A SCHEMA WITHOUT A MIGRATION IS A BROKEN DATABASE.
 *
 * Run #91 added `trustScore Int? @default(0)` to the `User` model in
 * `services/listings/prisma/schema.prisma` — a model documented as a read-only mirror of a table
 * the listings service does not own — and shipped no migration. It scored review 35, tests 0,
 * security 55, and committed at 63 against a threshold of 60.
 *
 * Nothing downstream could see it. The file parses; it is not JavaScript, so no export disappeared;
 * no suite covered it; and the app BOOTS, because Prisma validates a field against the database
 * only when a query runs. The damage surfaced weeks later as "I can't see business users any more":
 * every `User` read from the listings service was asking Postgres for a column that has never
 * existed, and the service turned each one into a 500.
 *
 * The rule is deterministic and narrow: fields added to a model in a schema file, with no migration
 * added in the same change. Removing a field is not covered — that is a different (and usually
 * deliberate) operation, and Prisma tolerates a table having columns the model does not name.
 */

/** Schema files whose model fields map to real database columns. */
import { changedPaths } from './changedLines.js';

const SCHEMA_FILE = /\.prisma$/i;

/** Anything that would actually create the column. */
const MIGRATION_FILE = /(^|\/)(migrations?|migrate)\//i;

/**
 * Field lines added to a Prisma model by this diff.
 *
 * Prisma field lines are `  name  Type  @attrs`. Excluded: block delimiters, comments, attributes
 * (`@@map`, `@@index`), and relation fields — a relation is a virtual field with no column behind
 * it, so requiring a migration for one would fire on every legitimate association.
 */
export function addedSchemaFields(diff = '') {
  const out = [];
  const removed = new Set();
  let file = null;

  // First pass: field names this diff also DELETES. Prisma models get re-aligned whenever a field
  // is added — adding one long name re-indents the whole block — so a naive read of the `+` lines
  // reports every field in the model as new. Only names that appear on the added side and nowhere
  // on the removed side are actually new. (Verified against run #91: without this the guard named
  // `id`, `name` and `handle` alongside the one field that was genuinely added.)
  for (const line of String(diff).split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; continue; }
    if (!file || !SCHEMA_FILE.test(file)) continue;
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const m = /^([A-Za-z_]\w*)\s+/.exec(line.slice(1).trim());
    if (m) removed.add(`${file}:${m[1]}`);
  }

  file = null;
  for (const line of String(diff).split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; continue; }
    if (!file || !SCHEMA_FILE.test(file)) continue;
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    const body = line.slice(1).trim();
    if (!body || body.startsWith('//') || body.startsWith('@@') || body.startsWith('}') || body.startsWith('{')) continue;
    // `name Type ...` — a scalar field. A relation names a model type and carries `@relation`, and
    // a list (`Item[]`) is likewise virtual.
    const m = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?\s*(.*)$/.exec(body);
    if (!m) continue;
    const [, name, type, isList, , rest] = m;
    if (isList || /@relation/.test(rest)) continue;
    // A capitalised type with no scalar meaning is another model — i.e. a relation without the
    // explicit attribute. Prisma's scalars and its common native types are all covered here.
    const SCALAR = /^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported)$/;
    if (!SCALAR.test(type)) continue;
    // Present on both sides: the line moved or was re-indented, not introduced.
    if (removed.has(`${file}:${name}`)) continue;
    out.push({ file, field: name, type });
  }
  return out;
}

/** Did this change add anything that would create the column? */
export function hasMigration(diff = '', files = []) {
  const touched = files.length ? files : changedPaths(diff);
  return touched.some((f) => MIGRATION_FILE.test(f) || /\.sql$/i.test(f));
}

/**
 * @param {string} diff   the unified diff
 * @param {string[]} files paths the change touched (optional; derived from the diff otherwise)
 * @returns {{veto:boolean, fields:Array, checked:boolean, summary:string}}
 */
export function checkSchemaMigrations(diff = '', files = []) {
  const fields = addedSchemaFields(diff);
  if (!fields.length) return { veto: false, fields: [], checked: true, summary: 'no schema fields added' };
  if (hasMigration(diff, files)) {
    return { veto: false, fields, checked: true, summary: `${fields.length} schema field(s) added, with a migration` };
  }
  const list = fields.map((f) => `${f.field} (${f.file})`).join(', ');
  return {
    veto: true,
    fields,
    checked: true,
    summary: `added ${list} to a schema with no migration — the column will not exist, and every query selecting it fails at runtime`,
  };
}
