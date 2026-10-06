/**
 * Build the ISL business document as a PDF.
 *
 *   node tools/pdf/build.mjs
 *
 * Route: HTML → headless Chrome → `Page.printToPDF` over the DevTools protocol. Chrome is used
 * rather than a PDF library because the requirement is a document that reads professionally —
 * real typography, tables that break across pages sensibly, vector diagrams, live internal links —
 * and reproducing that by drawing to a canvas is a large amount of work to get worse output.
 *
 * The DevTools protocol rather than the `--print-to-pdf` flag: the flag stamps Chrome's own header,
 * which prints the `file://` path of the source across the top of every page. `printToPDF` takes
 * header and footer templates, so the running head and the page numbers are ours.
 *
 * Every word of ISL.md is included, converted rather than retyped — see md2html.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { mdToHtml } from './md2html.mjs';
import * as D from './diagrams.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT_HTML = path.join(HERE, 'ISL.html');
const OUT_PDF = path.join(ROOT, 'ISL — How it works.pdf');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const today = new Date().toISOString().slice(0, 10);

/* ───────────────────────────────── styles ───────────────────────────────── */

const CSS = `
:root {
  --ink: #0f172a; --body: #334155; --muted: #64748b; --line: #e2e8f0;
  --soft: #f8fafc; --accent: #b91c3c; --accent-soft: #fbe9ed;
}
@page { size: A4; margin: 20mm 16mm 18mm 16mm; }
* { box-sizing: border-box; }
/* Explicit, not inherited. A print stylesheet that leaves the background to the default is one
   forced-dark-mode setting away from dark text on a dark page. */
html, body { background: #ffffff; }
body {
  font-family: 'Segoe UI', Inter, system-ui, -apple-system, sans-serif;
  color: var(--body); font-size: 10.2pt; line-height: 1.55; margin: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  color-scheme: only light;
}
h1, h2, h3, h4 { color: var(--ink); line-height: 1.25; font-weight: 650; margin: 1.4em 0 .5em; }
h1 { font-size: 20pt; }
h2 { font-size: 14pt; border-bottom: 1.5px solid var(--line); padding-bottom: .28em; }
h3 { font-size: 11.6pt; }
h4 { font-size: 10.6pt; color: var(--body); }
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
p { margin: .55em 0; orphans: 3; widows: 3; }
ul, ol { margin: .5em 0 .7em; padding-left: 1.3em; }
li { margin: .2em 0; }
a { color: var(--accent); text-decoration: none; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; }
strong { color: var(--ink); font-weight: 650; }

code {
  font-family: 'Consolas', 'SF Mono', monospace; font-size: .88em;
  background: var(--soft); border: 1px solid var(--line); border-radius: 3px; padding: .05em .3em;
  color: #0f172a;
}
pre.code {
  background: var(--soft); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 4px; padding: .7em .9em; overflow: hidden; break-inside: avoid; page-break-inside: avoid;
  font-size: 8.4pt; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
}
pre.code code { background: none; border: 0; padding: 0; font-size: inherit; }

table { width: 100%; border-collapse: collapse; margin: .8em 0 1.1em; font-size: 9.1pt; }
thead { display: table-header-group; }
th, td { border: 1px solid var(--line); padding: .42em .6em; text-align: left; vertical-align: top; }
th { background: var(--soft); color: var(--ink); font-weight: 650; font-size: 8.8pt;
     text-transform: uppercase; letter-spacing: .03em; }
tr { break-inside: avoid; page-break-inside: avoid; }
td code { font-size: .92em; }

blockquote {
  margin: .8em 0; padding: .6em .95em; background: var(--accent-soft);
  border-left: 3px solid var(--accent); border-radius: 0 4px 4px 0; color: var(--ink);
}

/* a source h1 marks a Part — give it a fresh page */
h1.part { break-before: page; page-break-before: always; margin-top: 0; padding-top: .2em; }

.cover { height: 247mm; display: flex; flex-direction: column; justify-content: space-between;
         break-after: page; page-break-after: always; }
.cover .rule { height: 5px; background: var(--accent); width: 78px; border-radius: 3px; }
.cover h1 { font-size: 33pt; margin: .35em 0 .1em; letter-spacing: -.5px; border: 0; }
.cover .sub { font-size: 14pt; color: var(--muted); font-weight: 350; }
.cover .lede { font-size: 11.4pt; max-width: 128mm; margin-top: 1.6em; color: var(--body); }
.cover .meta { font-size: 9.2pt; color: var(--muted); border-top: 1px solid var(--line); padding-top: .9em; }
.cover .meta b { color: var(--ink); font-weight: 600; }

.section { break-before: page; page-break-before: always; }
.lead { font-size: 11.2pt; color: var(--ink); }

figure { margin: 1.2em 0 1.5em; break-inside: avoid; page-break-inside: avoid; }
figure svg { width: 100%; height: auto; display: block; }
figcaption { font-size: 8.8pt; color: var(--muted); margin-top: .55em; padding-top: .45em;
             border-top: 1px solid var(--line); }
figcaption b { color: var(--ink); font-weight: 600; }

.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 1em 0 1.3em; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: .75em .9em; background: #fff;
        break-inside: avoid; }
.card h4 { margin: 0 0 .3em; font-size: 10pt; color: var(--ink); }
.card p { margin: 0; font-size: 9.4pt; }

.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 1.1em 0 1.4em; }
.kpi { border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 5px;
       padding: .7em .8em; background: #fff; }
.kpi .n { font-size: 17pt; font-weight: 700; color: var(--ink); line-height: 1.1; }
.kpi .l { font-size: 8.4pt; color: var(--muted); margin-top: .2em; }

.toc { columns: 2; column-gap: 14mm; font-size: 9.6pt; }
.toc a { color: var(--body); display: block; padding: .13em 0; break-inside: avoid; }
.toc a.l1 { font-weight: 650; color: var(--ink); margin-top: .7em; }
.toc a.l2 { padding-left: .8em; }
.note { font-size: 9.2pt; color: var(--muted); border-left: 2px solid var(--line); padding-left: .8em; }
`;

/* ─────────────────────────────── front matter ─────────────────────────────── */

const fig = (svg, n, caption) =>
  `<figure>${svg}<figcaption><b>Figure ${n}.</b> ${caption}</figcaption></figure>`;

function frontMatter(outline) {
  const toc = outline
    .filter((o) => o.level <= 2)
    .map((o) => `<a class="l${o.level}" href="#${o.id}">${o.text}</a>`)
    .join('\n');

  return `
<section class="cover">
  <div>
    <div class="rule"></div>
    <h1>ISL</h1>
    <div class="sub">Improvement Software Loop</div>
    <p class="lede">
      An autonomous control plane that takes any codebase you point it at, works out what is worth
      changing, makes the change in isolation, and proves the result before it is allowed to land.
    </p>
  </div>
  <div class="meta">
    <b>Technical &amp; business reference</b> · complete — every section of ISL.md is reproduced in
    Part II onwards<br/>
    Generated ${today} · confidential
  </div>
</section>

<section>
  <h2>Executive summary</h2>
  <p class="lead">
    Software decays faster than teams can maintain it. The backlog of work that everyone agrees
    should happen — the missing test, the function nobody dares refactor, the dependency with a
    published CVE, the accessibility gap — loses every week to work with a deadline attached. ISL
    exists to do that work continuously, and to prove it did it correctly.
  </p>

  <div class="kpis">
    <div class="kpi"><div class="n">12</div><div class="l">deterministic vetoes before any commit</div></div>
    <div class="kpi"><div class="n">13</div><div class="l">specialist agents, routed by learned competence</div></div>
    <div class="kpi"><div class="n">10</div><div class="l">pipeline phases per iteration</div></div>
    <div class="kpi"><div class="n">0</div><div class="l">changes to your main branch or working tree</div></div>
  </div>

  <h3>What it is</h3>
  <p>
    ISL is not a code generator with a chat box. It is a loop with a memory. It reads a project and
    its documentation, decides what to work on, sends the task to the specialist with the best
    record on that kind of work, applies the change inside a disposable sandbox, and then submits the
    result to a stack of checks that owe nothing to the model that produced it. A change that fails
    any of them is discarded, the target is charged a failure, and the next plan is different
    because of it.
  </p>

  <h3>Why the guardrails are the product</h3>
  <p>
    Any capable model can write a plausible patch. The difficult part — and the part that decides
    whether an autonomous loop is an asset or a liability — is refusing the plausible patch that is
    wrong. ISL's checks are deterministic: they do not ask a model for an opinion, they can each be
    traced to the exact line that triggered them, and no score overrides them. This document is
    explicit about the failures that produced each one, because a guardrail whose origin is a real
    incident is easier to trust than one derived from principle.
  </p>

  <h3>What it is for</h3>
  <p>
    Point ISL at a folder. Nothing needs to be instrumented, ported or rewritten first. It
    catalogues what is there, builds a grounded picture of the project from its own documents, asks
    a short list of questions only where the documents genuinely do not answer, and starts work.
  </p>

  <div class="cards">
    <div class="card"><h4>Continuous maintenance</h4><p>Complexity, dead code, missing tests, stale documentation and structural debt — worked through steadily rather than in an annual clean-up that never arrives.</p></div>
    <div class="card"><h4>Security &amp; compliance</h4><p>Secrets and weakened controls caught in the diff; dependency CVEs found and safe upgrades computed; best-practice rules audited across every language in the repo.</p></div>
    <div class="card"><h4>Reliability</h4><p>The app is booted on every iteration. A change that compiles, passes tests and stops the product from starting does not land.</p></div>
    <div class="card"><h4>Evidence</h4><p>Every commit records what produced it, what checked it, and what each check found — the audit trail a regulated team has to produce anyway.</p></div>
  </div>

  ${fig(D.diagramPurpose, 1, 'Any codebase in, a verified change out — and the outcome of that change becomes an input to the next decision. Nothing is written outside a sandbox, and nothing reaches your main branch without a human or an explicit policy allowing it.')}

  <h3>Where a human stays in the loop</h3>
  <p>
    Autonomy is a dial, not a switch. Low-risk work by an agent with a proven record can land on the
    work branch on its own; anything risky, or anything from an agent still earning trust, waits in
    an approval inbox. Promotion to your main branch is a separate, explicit act that is off by
    default. A rejection is not discarded — it becomes a durable lesson and costs the agent its
    standing on that kind of work.
  </p>
</section>

<section class="section">
  <h2>How it works</h2>
  <p class="lead">
    One iteration is ten phases, run inside a git worktree cut from the work branch. The first four
    decide and produce a change; the last six try to find something wrong with it.
  </p>

  ${fig(D.diagramPipeline, 2, 'The iteration pipeline. Phases 5–9 are the graders; the vetoes are applied together in <code>finalize</code>, so a change is judged as a whole rather than abandoned halfway. A rollback costs one iteration and leaves no trace outside the sandbox.')}

  <h3>Why a score was not enough</h3>
  <p>
    ISL originally decided by weighted average against a threshold. That failed in a way worth
    documenting, because the failure is arithmetic rather than bad luck: the grader that asks
    <em>“is this the change we asked for?”</em> carries a weight of 0.2, while four checks measuring
    mechanical properties of the result carry 0.8 between them. A review of zero alongside four
    near-perfect mechanical scores totals 79 — comfortably above a rollback threshold of 60.
  </p>
  <p>
    Four changes that reached the target application in production were traced back to exactly this.
    In every one, the reviewer had objected and been outvoted.
  </p>

  ${fig(D.diagramWhyVeto, 3, 'A weight cannot stop anything on its own. The fix was not to re-tune the weights but to add vetoes — conditions that are not matters of degree — and a floor under the one judgement in the system.')}

  ${fig(D.diagramFlywheel, 4, 'The loop improves at choosing, not only at writing. A failed target sinks in the ranking, a rejected change becomes a recorded pitfall, and the agent that produced it loses standing on that kind of work.')}

  ${fig(D.diagramArchitecture, 5, 'The layers. Nothing about the project being improved is fixed at boot: configuration values are live bindings and the database handle is swappable, so switching project re-points the entire runtime without a restart.')}

  ${fig(D.diagramSafety, 6, 'The boundary is enforced in code, not documented as a convention. The flag that would delete a database volume is refused by the runtime, and a test reads the source to make sure no future command reintroduces it.')}
</section>

<section class="section">
  <h2>Contents of the technical reference</h2>
  <p class="note">
    Everything that follows is the complete text of <code>ISL.md</code>, the maintained technical
    reference, reproduced without omission. Its own table of contents is retained; this listing is
    generated from the document as printed.
  </p>
  <div class="toc">${toc}</div>
</section>
`;
}

/* ─────────────────────────────── build ─────────────────────────────── */

const md = fs.readFileSync(path.join(ROOT, 'ISL.md'), 'utf8');
const { html: body, outline } = mdToHtml(md);

const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ISL — How it works</title><style>${CSS}</style></head>
<body>
${frontMatter(outline)}
${body}
</body></html>`;

fs.writeFileSync(OUT_HTML, doc, 'utf8');
console.log(`html  → ${OUT_HTML} (${(doc.length / 1024).toFixed(0)} KB, ${outline.length} headings)`);

if (!CHROME) {
  console.error('No Chrome or Edge found — the HTML is written; open it and print to PDF.');
  process.exit(1);
}

const PORT = 9333 + (process.pid % 200);
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + path.join(HERE, '.chrome-profile'),
  'about:blank',
], { stdio: 'ignore' });

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Join the clean cover to the rest. Uses pypdf if it is present — merging PDF cross-reference
 * tables by hand is a poor use of a build script — and reports failure rather than throwing, so the
 * caller can fall back to a single-pass document.
 */
function mergePdfs(a, b, out) {
  const script = `
import sys
from pypdf import PdfWriter
w = PdfWriter()
for f in sys.argv[1:3]:
    w.append(f)
with open(sys.argv[3], 'wb') as fh:
    w.write(fh)
print('ok')
`;
  const scriptPath = path.join(HERE, '.merge.py');
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
    const r = spawnSync('python', [scriptPath, a, b, out], { encoding: 'utf8' });
    return r.status === 0 && String(r.stdout).includes('ok');
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* already gone */ }
  }
}

async function main() {
  /*
   * Connect to the PAGE target, not the browser one. `/json/version` gives the browser endpoint,
   * which speaks Target and Browser but not Page — attaching there fails with
   * "'Page.enable' wasn't found", which reads like a Chrome version problem and is not one.
   */
  let page = null;
  for (let n = 0; n < 40 && !page; n++) {
    await wait(250);
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
    page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }
  if (!page) throw new Error('Chrome exposed no page target to drive');

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) events.push(m.method);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + OUT_HTML.replace(/\\/g, '/') });

  // Wait for the load event rather than a fixed sleep: the document is large, and a short sleep
  // would silently produce a PDF of a half-laid-out page.
  for (let n = 0; n < 120 && !events.includes('Page.loadEventFired'); n++) await wait(100);
  await wait(700); // fonts and final layout

  const head = `<div style="width:100%;font-size:7pt;color:#94a3b8;font-family:Segoe UI,sans-serif;
      padding:0 16mm;display:flex;justify-content:space-between;">
      <span>ISL — Improvement Software Loop</span><span>Technical &amp; business reference</span></div>`;
  const foot = `<div style="width:100%;font-size:7pt;color:#94a3b8;font-family:Segoe UI,sans-serif;
      padding:0 16mm;display:flex;justify-content:space-between;">
      <span>${today}</span><span class="pageNumber"></span></div>`;

  const print = (extra) =>
    send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.75,
      marginBottom: 0.7,
      marginLeft: 0.63,
      marginRight: 0.63,
      preferCSSPageSize: false,
      ...extra,
    });

  /*
   * Two passes, because Chrome applies the running head and the page number to EVERY page,
   * including the cover — and a cover with a running head across the top reads as a draft. There is
   * no way to suppress it for one page from inside the template, so the cover is printed clean, the
   * rest with furniture, and the two are joined.
   */
  const cover = await print({ pageRanges: '1', displayHeaderFooter: false });
  const rest = await print({ pageRanges: '2-', displayHeaderFooter: true, headerTemplate: head, footerTemplate: foot });

  const coverPath = path.join(HERE, '.cover.pdf');
  const restPath = path.join(HERE, '.rest.pdf');
  fs.writeFileSync(coverPath, Buffer.from(cover.data, 'base64'));
  fs.writeFileSync(restPath, Buffer.from(rest.data, 'base64'));

  const merged = mergePdfs(coverPath, restPath, OUT_PDF);
  if (!merged) {
    // Falling back rather than failing: a single-pass PDF with a running head on the cover is a
    // cosmetic loss, and losing the document entirely is not.
    const whole = await print({ displayHeaderFooter: true, headerTemplate: head, footerTemplate: foot });
    fs.writeFileSync(OUT_PDF, Buffer.from(whole.data, 'base64'));
    console.log('note  → merged cover unavailable; wrote a single-pass PDF instead');
  }
  for (const f of [coverPath, restPath]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }

  console.log(`pdf   → ${OUT_PDF} (${(fs.statSync(OUT_PDF).size / 1024 / 1024).toFixed(2)} MB)`);
  ws.close();
  chrome.kill();
}

main().catch((e) => {
  console.error('build failed:', e.message);
  chrome.kill();
  process.exit(1);
});
