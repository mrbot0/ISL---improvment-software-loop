import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/db_iteration.js';
import { openProjectDb } from '../src/db.js';
import { setActiveProjectConfig } from '../src/config.js';
import { extractText, classify, DOC_EXTENSIONS } from '../src/context/extract.js';
import { ingestDocuments } from '../src/context/ingest.js';
import { getDocumentByPath, documentHashes, documentStats } from '../src/context/contextDb.js';

/**
 * EVERY PDF THE CONTEXT MANAGER EVER READ CAME BACK EMPTY.
 *
 * `extract.js` imported `pdf-parse/lib/pdf-parse.js` — the layout of pdf-parse v1. The declared
 * dependency is `^2.4.5`, which is ESM-only, exposes no `./lib/*` subpath and has no default
 * export at all; it exports a `PDFParse` class. So the import threw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, the catch recorded the message, and the document was stored
 * with `chars = 0`.
 *
 * Nothing broke. That is the whole problem. `buildCorpus()` skips a document with no text
 * (`if (!text) continue`), so the profile — the invariants and risks every agent is later handed
 * as ground truth — was derived from whatever happened to be left. On the two live projects that
 * silently excluded the deployment guide, the features-and-tables reference, the technical design
 * rationale, the porting guide and the architecture flowchart: six of six PDFs, nought characters
 * each, and the richest description of each system among them.
 *
 * These tests pin the contract that was never checked: a readable document yields text, and a
 * document that cannot be read says so instead of passing for empty.
 */

/**
 * A minimal well-formed single-page PDF with real extractable text, built here rather than
 * committed as a binary: a fixture you can read is a fixture you can trust. The xref offsets are
 * computed so the parser never falls back to recovery mode.
 */
function tinyPdf(message = 'ISL context extraction works') {
  const content = `BT /F1 24 Tf 72 700 Td (${message}) Tj ET\n`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-extract-'));
const write = (name, data) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};

test('a PDF yields its text, not an empty document', async () => {
  const doc = await extractText(write('guide.pdf', tinyPdf('The booking service owns availability')));

  assert.equal(doc.error, undefined, `extraction reported an error: ${doc.error}`);
  assert.equal(doc.type, 'pdf');
  assert.match(doc.text, /booking service owns availability/);
  assert.ok(doc.chars > 0, 'chars must reflect the extracted text');
  assert.equal(doc.chars, doc.text.length, 'chars must match the text actually stored');
});

test('PDF text carries no page-separator boilerplate', async () => {
  // pdf-parse v2 interleaves "-- 1 of 38 --" markers into its `text` field. Inside a corpus
  // budget measured in characters that is noise a model reads as content, so the extractor
  // joins the per-page text instead.
  const doc = await extractText(write('sep.pdf', tinyPdf('Availability is computed per branch')));

  assert.doesNotMatch(doc.text, /--\s*\d+\s*of\s*\d+\s*--/, 'page separators must not reach the corpus');
  assert.match(doc.text, /Availability is computed per branch/);
});

test('an unreadable PDF reports an error rather than passing for empty', async () => {
  const doc = await extractText(write('broken.pdf', Buffer.from('%PDF-1.4\nthis is not a pdf body\n')));

  assert.ok(doc.error, 'a corrupt PDF must carry an error');
  assert.equal(doc.chars, 0);
  // The distinction that matters downstream: `buildCorpus()` skips empty text either way, so the
  // error column is the only thing separating "nothing to say" from "we could not look".
  assert.equal(doc.type, 'pdf');
});

test('markdown still extracts, with a title from its first heading', async () => {
  const doc = await extractText(write('README.md', '# Lending System\n\nHolds move items between branches.\n'));

  assert.equal(doc.error, undefined);
  assert.equal(doc.type, 'md');
  assert.equal(doc.title, 'Lending System');
  assert.match(doc.text, /Holds move items between branches/);
});

test('classification and the ingest filter agree on what a document is', () => {
  assert.equal(classify('.PDF'), 'pdf');
  assert.equal(classify('.mdx'), 'md');
  assert.equal(classify('.asciidoc'), 'adoc');
  assert.equal(classify('.bin'), 'other');
  // Anything classify() names must also be walked by the ingester, or it can never be classified.
  for (const ext of ['.pdf', '.docx', '.md', '.mdx', '.rst', '.adoc', '.txt']) {
    assert.ok(DOC_EXTENSIONS.has(ext), `${ext} is classified but never ingested`);
  }
});

/**
 * A FAILED EXTRACTION MUST NOT BECOME PERMANENT.
 *
 * Fixing the parser was not enough to recover a single document. `ingestDocuments()` skips any
 * file whose mtime is unchanged since the last pass, and `documentHashes()` — the only thing the
 * skip consults — reports `{hash, mtime}` and nothing about whether the last attempt succeeded.
 * So a document that failed is skipped on every subsequent run: the extractor is repaired, the
 * file is untouched, and the row stays at `chars = 0` for good. Only a *forced* rebuild, which
 * nothing prompts the operator to run, would have picked those six PDFs up.
 *
 * It generalises past this bug. A file locked by another process, an out-of-memory part-way
 * through a large parse, a service blip — each is cached as a permanent verdict. The skip is an
 * optimisation for work already done, so it must require that the work actually succeeded.
 */
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-ingest-'));

before(() => {
  openProjectDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isl-ingest-db-')), 'p.sqlite'));
  setActiveProjectConfig({ repoRoot: project });
});

test('a failed document is retried next pass, while a successful one is still skipped', async () => {
  const pdf = path.join(project, 'guide.pdf');
  fs.writeFileSync(path.join(project, 'README.md'), '# Lending System\n\nBranches share a catalogue.\n');
  fs.writeFileSync(pdf, '%PDF-1.4\nnot a parsable pdf body\n');

  // Pass 1: the markdown reads, the PDF does not — exactly the state of the two live projects.
  const first = await ingestDocuments({});
  assert.equal(first.extracted, 1, 'the markdown should extract');
  assert.equal(first.failed, 1, 'the unreadable PDF should be counted as failed');
  const broken = getDocumentByPath('guide.pdf');
  assert.ok(broken.error, 'the failure must be recorded');
  assert.equal(broken.chars, 0);

  // Pass 2 with NOTHING touched on disk. One ingest settles both halves of the contract: the
  // document that succeeded is spared, the one that failed is attempted again. Asserting on an
  // untouched tree is what keeps this honest — no mtime had to be forged to reach the branch.
  const second = await ingestDocuments({});
  assert.equal(second.skipped, 1, 'only the markdown, which succeeded, may be skipped');
  assert.equal(second.failed, 1, 'the failed PDF must be attempted again, not cached as hopeless');
});

test('a retried document picks up its text once it can be read', async () => {
  // The repair this whole file exists for: the parser now works and the document recovers on an
  // ordinary, unforced pass.
  fs.writeFileSync(path.join(project, 'guide.pdf'), tinyPdf('Branch transfers settle overnight'));

  await ingestDocuments({});
  const healed = getDocumentByPath('guide.pdf');

  assert.equal(healed.error, null, `still failing: ${healed.error}`);
  assert.match(healed.text, /Branch transfers settle overnight/);
  assert.ok(healed.chars > 0, 'a retried document must end up with its text');

  // And once it has succeeded it joins the fast path, so a repaired corpus is not re-parsed for ever.
  const settled = await ingestDocuments({});
  assert.equal(settled.extracted, 0, 'nothing changed, so nothing should be re-extracted');
  assert.equal(settled.skipped, 2, 'both documents now have a successful extraction behind them');
  assert.equal(settled.failed, 0);
});

test('the skip is told whether the previous attempt succeeded', () => {
  // The predicate in ingest.js can only honour a failure it can see.
  const known = documentHashes();
  assert.ok('error' in known['guide.pdf'], 'documentHashes() must expose the previous error');
  assert.ok('mtime' in known['guide.pdf']);
});

test('a failed re-read keeps the text from the last good one', async () => {
  // The document is readable right now (the previous test healed it). If it becomes unreadable —
  // locked by another process, truncated mid-write, out of memory on a large parse — the old
  // `text = excluded.text` wrote '' over a perfectly good extraction. Degrading to the last known
  // text is strictly better than degrading to nothing, and the error still records what happened.
  const before = getDocumentByPath('guide.pdf');
  assert.ok(before.chars > 0, 'premise: the document currently has text');

  fs.writeFileSync(path.join(project, 'guide.pdf'), '%PDF-1.4\ntruncated mid-write\n');
  await ingestDocuments({});

  const after = getDocumentByPath('guide.pdf');
  assert.ok(after.error, 'the new failure must be recorded');
  assert.match(after.text, /Branch transfers settle overnight/, 'the last good text must survive');
  assert.equal(after.chars, before.chars, 'chars must stay consistent with the text kept');
});

test('the document summary counts what could not be read', () => {
  // `ContextManager.analyze()` reported "documentation healthy" over a corpus in which five of
  // fifty-nine documents held zero characters, because documentStats() had no notion of failure.
  // An operator cannot act on a number nobody computes.
  const stats = documentStats();

  assert.equal(stats.failed, 1, 'the unreadable PDF must be counted');
  assert.equal(stats.total, 2);
});

test('an unreadable project folder does not wipe the document index', async () => {
  // walk() swallows readdirSync errors and returns [], so a renamed folder, an unmounted network
  // drive or a permissions change all look identical to "every document was deleted" — and
  // pruneDocumentsNotIn([]) would act on that, destroying the whole index.
  const before = documentStats().total;
  assert.ok(before > 0, 'premise: there are documents on record');

  setActiveProjectConfig({ repoRoot: path.join(project, 'moved-away') });
  try {
    const res = await ingestDocuments({});
    assert.equal(res.scanned, 0, 'premise: the scan finds nothing');
    assert.equal(res.removed, 0, 'an empty scan must prune nothing');
    assert.equal(documentStats().total, before, 'the index must survive an unreadable folder');
  } finally {
    setActiveProjectConfig({ repoRoot: project });
  }
});
