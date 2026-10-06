/**
 * Flow diagrams for the ISL business document.
 *
 * Inline SVG rather than an image library: it stays vector in the PDF (crisp at any zoom, and
 * selectable/searchable text), it needs no build step, and the print palette can be tuned directly.
 *
 * Palette is print-first — dark ink on white, one accent, and state colours only where state is the
 * point. Screen conventions (dark backgrounds, saturated fills) waste toner and read as muddy.
 */

const C = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  line: '#cbd5e1',
  soft: '#f1f5f9',
  accent: '#b91c3c',
  accentSoft: '#fbe9ed',
  ok: '#15803d',
  okSoft: '#e7f5ec',
  warn: '#b45309',
  warnSoft: '#fdf2e3',
  stop: '#b91c1c',
  stopSoft: '#fdeaea',
  info: '#1d4ed8',
  infoSoft: '#e8eefc',
};

const defs = `
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.muted}"/>
  </marker>
  <marker id="arrowAccent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.accent}"/>
  </marker>
  <marker id="arrowStop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${C.stop}"/>
  </marker>
</defs>`;

const box = (x, y, w, h, { fill = '#fff', stroke = C.line, r = 6, sw = 1.2 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

const text = (x, y, s, { size = 12, weight = 400, fill = C.ink, anchor = 'middle', mono = false } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" font-family="${
    mono ? "'SF Mono','Consolas',monospace" : "'Inter','Segoe UI',system-ui,sans-serif"
  }">${s}</text>`;

/* ───────────────────────── 1. What ISL is for ───────────────────────── */

export const diagramPurpose = `
<svg viewBox="0 0 720 300" role="img" aria-label="How a codebase enters ISL and leaves as a verified improvement">
${defs}
  ${box(10, 60, 150, 170, { fill: C.soft })}
  ${text(85, 88, 'ANY CODEBASE', { size: 11, weight: 700, fill: C.muted })}
  ${text(85, 116, 'Web app · API · service', { size: 11, fill: C.body })}
  ${text(85, 134, 'Monolith · microservices', { size: 11, fill: C.body })}
  ${text(85, 152, 'Any language ISL can', { size: 11, fill: C.body })}
  ${text(85, 168, 'catalogue and run', { size: 11, fill: C.body })}
  ${text(85, 198, 'You point it at a folder.', { size: 10.5, fill: C.muted })}
  ${text(85, 213, 'Nothing else to install.', { size: 10.5, fill: C.muted })}

  <path d="M 168 145 L 205 145" stroke="${C.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>

  ${box(212, 40, 296, 210, { fill: '#fff', stroke: C.accent, sw: 1.6 })}
  ${text(360, 66, 'ISL', { size: 15, weight: 700, fill: C.accent })}
  ${text(360, 84, 'the improvement loop', { size: 10.5, fill: C.muted })}

  ${box(228, 100, 126, 52, { fill: C.infoSoft, stroke: C.info })}
  ${text(291, 120, 'UNDERSTAND', { size: 10, weight: 700, fill: C.info })}
  ${text(291, 137, 'read the code + docs', { size: 10, fill: C.body })}

  ${box(366, 100, 126, 52, { fill: C.infoSoft, stroke: C.info })}
  ${text(429, 120, 'DECIDE', { size: 10, weight: 700, fill: C.info })}
  ${text(429, 137, 'what is worth fixing', { size: 10, fill: C.body })}

  ${box(228, 164, 126, 52, { fill: C.accentSoft, stroke: C.accent })}
  ${text(291, 184, 'CHANGE', { size: 10, weight: 700, fill: C.accent })}
  ${text(291, 201, 'in an isolated sandbox', { size: 10, fill: C.body })}

  ${box(366, 164, 126, 52, { fill: C.okSoft, stroke: C.ok })}
  ${text(429, 184, 'PROVE', { size: 10, weight: 700, fill: C.ok })}
  ${text(429, 201, '12 vetoes + it boots', { size: 10, fill: C.body })}

  <path d="M 360 152 L 360 162" stroke="${C.muted}" stroke-width="1.2" marker-end="url(#arrow)"/>

  <path d="M 516 145 L 553 145" stroke="${C.ok}" stroke-width="1.5" marker-end="url(#arrow)"/>

  ${box(560, 60, 150, 170, { fill: C.okSoft, stroke: C.ok })}
  ${text(635, 88, 'VERIFIED CHANGE', { size: 11, weight: 700, fill: C.ok })}
  ${text(635, 116, 'Committed to a work', { size: 11, fill: C.body })}
  ${text(635, 132, 'branch — never to your', { size: 11, fill: C.body })}
  ${text(635, 148, 'main branch, never to', { size: 11, fill: C.body })}
  ${text(635, 164, 'your working tree', { size: 11, fill: C.body })}
  ${text(635, 194, 'With its evidence:', { size: 10.5, fill: C.muted })}
  ${text(635, 209, 'what ran, what it found', { size: 10.5, fill: C.muted })}

  <path d="M 635 240 C 635 275, 85 275, 85 240" stroke="${C.accent}" stroke-width="1.4" fill="none" stroke-dasharray="4 3" marker-end="url(#arrowAccent)"/>
  ${text(360, 288, 'what landed, and what was rejected, becomes the next decision', { size: 10, fill: C.accent })}
</svg>`;

/* ───────────────────────── 2. The iteration pipeline ───────────────────────── */

const PHASES = [
  ['catalog', 'index the code'],
  ['survey', 'find what is worth changing'],
  ['plan', 'turn findings into tasks'],
  ['implement', 'specialists edit, in parallel'],
  ['review', 'grade the diff'],
  ['security', 'secrets & weakened controls'],
  ['regression', 'public surface intact?'],
  ['test', "the project's own suite"],
  ['workbench', 'does the app still boot?'],
  ['finalize', 'commit — or roll back'],
];

export const diagramPipeline = `
<svg viewBox="0 0 720 560" role="img" aria-label="The ten-phase iteration pipeline and the vetoes applied before a commit">
${defs}
  ${text(20, 24, 'ONE ITERATION', { size: 11, weight: 700, fill: C.muted, anchor: 'start' })}
  ${text(20, 42, 'Every run is a sandbox cut from the work branch. Nothing outside it is touched.', { size: 10.5, fill: C.body, anchor: 'start' })}

  ${PHASES.map((p, n) => {
    const y = 62 + n * 40;
    const isGate = n >= 4 && n <= 8;
    return `
  ${box(20, y, 34, 30, { fill: isGate ? C.warnSoft : C.soft, stroke: isGate ? C.warn : C.line })}
  ${text(37, y + 20, String(n + 1), { size: 12, weight: 700, fill: isGate ? C.warn : C.muted })}
  ${box(60, y, 150, 30, { fill: '#fff' })}
  ${text(70, y + 20, p[0], { size: 11.5, weight: 600, anchor: 'start', mono: true })}
  ${text(222, y + 20, p[1], { size: 11, fill: C.body, anchor: 'start' })}
  ${n < PHASES.length - 1 ? `<path d="M 37 ${y + 30} L 37 ${y + 40}" stroke="${C.line}" stroke-width="1.4" marker-end="url(#arrow)"/>` : ''}`;
  }).join('')}

  ${box(430, 62, 274, 300, { fill: '#fff', stroke: C.stop, sw: 1.4 })}
  ${text(567, 86, 'THE TWELVE HARD VETOES', { size: 11, weight: 700, fill: C.stop })}
  ${text(567, 103, 'deterministic · traceable to a line · no score overrides them', { size: 9.5, fill: C.muted })}
  ${[
    'Parse — a file that does not compile',
    'Security — a secret, a critical finding',
    'Safety — a weakened control, a dropped table',
    'Broken tests — a suite this change broke',
    'Dead code — new code nothing calls',
    'Refactor — added code, deleted nothing',
    'Behaviour — a refactor that changed results',
    'Contract — an undeclared breaking change',
    'Change size — beyond the budget',
    'Coverage — changed lines below the floor',
    'Intent — deleted what it promised to add',
    'Schema — a field with no migration',
  ].map((v, n) => text(448, 128 + n * 19, `• ${v}`, { size: 10.2, fill: C.body, anchor: 'start' })).join('')}

  ${box(430, 376, 274, 56, { fill: C.accentSoft, stroke: C.accent })}
  ${text(567, 398, 'AND ONE FLOOR', { size: 10.5, weight: 700, fill: C.accent })}
  ${text(567, 416, 'a review below 70 is disqualifying on its own', { size: 10, fill: C.body })}

  <path d="M 214 240 L 424 200" stroke="${C.stop}" stroke-width="1.3" fill="none" marker-end="url(#arrowStop)"/>
  ${text(300, 226, 'applied in finalize', { size: 9.5, fill: C.stop })}

  ${box(20, 470, 320, 66, { fill: C.okSoft, stroke: C.ok })}
  ${text(180, 492, 'PASSES → committed to the work branch', { size: 11, weight: 600, fill: C.ok })}
  ${text(180, 512, 'with its provenance: what produced it,', { size: 10, fill: C.body })}
  ${text(180, 527, 'what checked it, and what each check found', { size: 10, fill: C.body })}

  ${box(370, 470, 334, 66, { fill: C.stopSoft, stroke: C.stop })}
  ${text(537, 492, 'FAILS → rolled back, nothing lands', { size: 11, weight: 600, fill: C.stop })}
  ${text(537, 512, 'the target is charged a failure, so the planner', { size: 10, fill: C.body })}
  ${text(537, 527, 'stops re-proposing it, and the reason is recorded', { size: 10, fill: C.body })}
</svg>`;

/* ───────────────────────── 3. Why a score was not enough ───────────────────────── */

export const diagramWhyVeto = `
<svg viewBox="0 0 720 250" role="img" aria-label="Why a weighted average could not stop a bad change, and what replaced it">
${defs}
  ${text(20, 24, 'THE ARITHMETIC THAT LET FOUR BAD CHANGES THROUGH', { size: 11, weight: 700, fill: C.muted, anchor: 'start' })}

  ${box(20, 44, 320, 150, { fill: C.stopSoft, stroke: C.stop })}
  ${text(180, 68, 'A weighted average', { size: 12, weight: 700, fill: C.stop })}
  ${[
    ['review', '0.20', 'is this the change we asked for?'],
    ['security', '0.20', 'mechanical'],
    ['regression', '0.30', 'mechanical'],
    ['test', '0.15', 'mechanical'],
    ['workbench', '0.15', 'mechanical'],
  ].map((r, n) => {
    const y = 92 + n * 18;
    return `${text(36, y, r[0], { size: 10.5, anchor: 'start', mono: true, fill: n === 0 ? C.stop : C.body })}
    ${text(110, y, r[1], { size: 10.5, anchor: 'start', mono: true, fill: C.muted })}
    ${text(150, y, r[2], { size: 10, anchor: 'start', fill: n === 0 ? C.stop : C.muted })}`;
  }).join('')}
  ${text(180, 184, 'review 0 + four near-perfect scores = 79 → commits', { size: 10.5, weight: 700, fill: C.stop })}

  <path d="M 348 118 L 384 118" stroke="${C.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>

  ${box(392, 44, 312, 150, { fill: C.okSoft, stroke: C.ok })}
  ${text(548, 68, 'A veto, plus a floor', { size: 12, weight: 700, fill: C.ok })}
  ${text(548, 92, 'A veto is not a matter of degree.', { size: 10.5, fill: C.body })}
  ${text(548, 110, 'A file either compiles or it does not;', { size: 10.5, fill: C.body })}
  ${text(548, 128, 'a column either exists or it does not.', { size: 10.5, fill: C.body })}
  ${text(548, 154, 'And the one human-like judgement in the', { size: 10.5, fill: C.body })}
  ${text(548, 170, 'system can now stop a change by itself.', { size: 10.5, fill: C.body })}
  ${text(548, 188, 'Measured: 31 of 115 commits scored review < 70', { size: 10, weight: 700, fill: C.ok })}

  ${text(360, 226, 'Evidence, not preference: the committed review scores fall in two clusters, 0–55 and 75–100,', { size: 10, fill: C.muted })}
  ${text(360, 241, 'with nothing between them. The floor was placed in that gap.', { size: 10, fill: C.muted })}
</svg>`;

/* ───────────────────────── 4. Architecture ───────────────────────── */

export const diagramArchitecture = `
<svg viewBox="0 0 720 380" role="img" aria-label="ISL's layered architecture and the multi-project foundation">
${defs}
  ${box(20, 20, 684, 62, { fill: C.soft })}
  ${text(40, 44, 'DASHBOARD', { size: 10.5, weight: 700, fill: C.muted, anchor: 'start' })}
  ${text(40, 64, 'React · 30 nav entries · login, roles, audit · every view a lazy chunk', { size: 10.5, fill: C.body, anchor: 'start' })}

  <path d="M 362 82 L 362 96" stroke="${C.muted}" stroke-width="1.3" marker-end="url(#arrow)"/>

  ${box(20, 100, 684, 74, { fill: '#fff', stroke: C.accent, sw: 1.5 })}
  ${text(40, 124, 'CONTROL PLANE', { size: 10.5, weight: 700, fill: C.accent, anchor: 'start' })}
  ${text(40, 144, 'One loop: the controller schedules iterations, the engine runs the ten phases,', { size: 10.5, fill: C.body, anchor: 'start' })}
  ${text(40, 161, 'the managers observe, the Decision Network routes work to the right specialist', { size: 10.5, fill: C.body, anchor: 'start' })}

  <path d="M 362 174 L 362 188" stroke="${C.muted}" stroke-width="1.3" marker-end="url(#arrow)"/>

  ${[
    ['AGENTS', 'thirteen specialists:', 'security, tests, frontend,', 'services, refactor, docs…', C.infoSoft, C.info],
    ['GUARDRAILS', 'no LLM involved:', 'the twelve vetoes,', 'scans, blast radius', C.warnSoft, C.warn],
    ['MEMORY', 'what worked before:', 'lessons, pitfalls,', 'the knowledge index', C.okSoft, C.ok],
  ].map((g, n) => {
    const x = 20 + n * 232;
    return `${box(x, 192, 220, 92, { fill: g[4], stroke: g[5] })}
    ${text(x + 110, 214, g[0], { size: 10.5, weight: 700, fill: g[5] })}
    ${text(x + 110, 234, g[1], { size: 10, fill: C.body })}
    ${text(x + 110, 250, g[2], { size: 10, fill: C.body })}
    ${text(x + 110, 266, g[3], { size: 10, fill: C.body })}`;
  }).join('')}

  <path d="M 362 284 L 362 298" stroke="${C.muted}" stroke-width="1.3" marker-end="url(#arrow)"/>

  ${box(20, 302, 684, 62, { fill: C.soft })}
  ${text(40, 326, 'PER-PROJECT FOUNDATION', { size: 10.5, weight: 700, fill: C.muted, anchor: 'start' })}
  ${text(40, 346, 'Each project has its own SQLite database and its own detected layout. Switching project re-points', { size: 10.5, fill: C.body, anchor: 'start' })}
  ${text(40, 360, 'the whole runtime — nothing about the code being improved is a boot-time constant.', { size: 10.5, fill: C.body, anchor: 'start' })}
</svg>`;

/* ───────────────────────── 5. The flywheel ───────────────────────── */

export const diagramFlywheel = `
<svg viewBox="0 0 720 300" role="img" aria-label="The self-improvement flywheel: outcomes feed back into the next decision">
${defs}
  ${[
    ['1', 'It changes code', 'a batch of small, verifiable tasks', 150, 70, C.infoSoft, C.info],
    ['2', 'The gates judge it', 'twelve vetoes, a floor, and the app booting', 570, 70, C.warnSoft, C.warn],
    ['3', 'The outcome is recorded', 'what landed, what was rejected, and why', 570, 220, C.okSoft, C.ok],
    ['4', 'The next decision changes', 'failures sink a target; lessons reach the planner', 150, 220, C.accentSoft, C.accent],
  ].map((n) => `
  ${box(n[3] - 130, n[4] - 42, 260, 84, { fill: n[5], stroke: n[6] })}
  ${text(n[3], n[4] - 18, `${n[0]}. ${n[1]}`, { size: 12, weight: 700, fill: n[6] })}
  ${text(n[3], n[4] + 6, n[2], { size: 10.2, fill: C.body })}`).join('')}

  <path d="M 282 70 L 438 70" stroke="${C.muted}" stroke-width="1.4" marker-end="url(#arrow)"/>
  <path d="M 570 114 L 570 176" stroke="${C.muted}" stroke-width="1.4" marker-end="url(#arrow)"/>
  <path d="M 438 220 L 282 220" stroke="${C.muted}" stroke-width="1.4" marker-end="url(#arrow)"/>
  <path d="M 150 176 L 150 114" stroke="${C.accent}" stroke-width="1.6" marker-end="url(#arrowAccent)"/>

  ${text(360, 156, 'the loop gets better at choosing, not just at typing', { size: 10.5, weight: 600, fill: C.accent })}
  ${text(360, 285, 'This is what separates ISL from a code generator: the result of a change is an input to the next one.', { size: 10, fill: C.muted })}
</svg>`;

/* ───────────────────────── 6. Safety boundaries ───────────────────────── */

export const diagramSafety = `
<svg viewBox="0 0 720 260" role="img" aria-label="What ISL may and may not touch">
${defs}
  ${text(20, 24, 'WHAT ISL MAY AND MAY NOT TOUCH', { size: 11, weight: 700, fill: C.muted, anchor: 'start' })}

  ${box(20, 42, 336, 200, { fill: C.okSoft, stroke: C.ok })}
  ${text(188, 66, 'MAY', { size: 12, weight: 700, fill: C.ok })}
  ${[
    'Write inside a disposable sandbox worktree',
    'Commit to its own work branch',
    'Read any file in the project',
    'Run the project’s own tests and boot it',
    'Read the database schema (information_schema)',
    'Stop, start or rebuild one container',
    'Open a pull request for a human to judge',
  ].map((s, n) => text(40, 96 + n * 20, `✓  ${s}`, { size: 10.3, fill: C.body, anchor: 'start' })).join('')}

  ${box(368, 42, 336, 200, { fill: C.stopSoft, stroke: C.stop })}
  ${text(536, 66, 'MAY NOT', { size: 12, weight: 700, fill: C.stop })}
  ${[
    'Touch your main branch or working tree',
    'Issue DDL, or edit a database schema file',
    'Delete a Docker volume (the flag is refused)',
    'Fast-forward to main unless explicitly enabled',
    'Reach the network outside the egress allowlist',
    'Land a change any veto rejected',
    'Repair drift it detects — it reports only',
  ].map((s, n) => text(388, 96 + n * 20, `✕  ${s}`, { size: 10.3, fill: C.body, anchor: 'start' })).join('')}
</svg>`;
