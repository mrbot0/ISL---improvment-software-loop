import { landedCommits } from '../summary.js';

/**
 * AUTO-CHANGELOG / RELEASE NOTES (ISL_IMPROVE "Next wave", P1).
 *
 * Turns the fleet's landed commits into human-readable, theme-grouped release notes with the
 * per-change evidence (score, files) ISL already records — so a promotion ships with a clear,
 * honest "what changed and why it's safe" instead of a wall of `[ai-iter#N]` subjects. Fully
 * deterministic: it reads the same landed-commit data the digest uses and buckets each change by a
 * keyword on its title. No LLM, so the notes are always the real list.
 */

const THEMES = [
  { key: 'Security', re: /\b(secur|auth|secret|vuln|cve|xss|csrf|saniti|escap|idempoten)/i },
  { key: 'Reliability', re: /\b(reliab|resilien|retry|timeout|circuit|error[- ]?handl|hardening|robust|fix)/i },
  { key: 'Tests & coverage', re: /\b(test|coverage|spec|characteri[sz])/i },
  { key: 'Refactoring', re: /\b(refactor|split|extract|complexit|god[- ]?file|dedup|simplif|consolidat)/i },
  { key: 'Frontend & UX', re: /\b(frontend|\bui\b|\bux\b|a11y|accessib|i18n|component|jsx|responsive|dashboard)/i },
  { key: 'Performance', re: /\b(perf|performance|cache|optimi|n\+1|latency|throughput)/i },
  { key: 'Features', re: /\b(add|feature|implement|new|support|introduce)/i },
];

function themeOf(title) {
  for (const t of THEMES) if (t.re.test(title || '')) return t.key;
  return 'Other';
}

const THEME_ORDER = THEMES.map((t) => t.key).concat('Other');

/**
 * Build release notes from the landed commits.
 * @returns {{ markdown, groups, totals, count }}
 */
export function generateChangelog({ limit = 150 } = {}) {
  const { commits, totals } = landedCommits({ limit });
  const groups = {};
  for (const c of commits) (groups[themeOf(c.title)] ||= []).push(c);

  const md = [];
  md.push('# Release notes');
  md.push('');
  md.push(
    `_${totals.commits} change(s) · ${totals.files} file(s) (+${totals.additions}/−${totals.deletions}) · ` +
      `${totals.improvements} improvement(s) · ${totals.features} feature(s) · avg score ${totals.avgScore ?? '—'}_`,
  );
  md.push('');

  const outGroups = [];
  for (const theme of THEME_ORDER) {
    const items = groups[theme];
    if (!items?.length) continue;
    md.push(`## ${theme} (${items.length})`);
    for (const c of items) {
      const bits = [`\`${c.sha}\``, `score ${c.score ?? '—'}`, `${c.filesChanged} file${c.filesChanged === 1 ? '' : 's'}`];
      md.push(`- ${c.title} — ${bits.join(', ')}`);
    }
    md.push('');
    outGroups.push({
      theme,
      count: items.length,
      items: items.map((c) => ({ id: c.id, sha: c.sha, title: c.title, score: c.score, filesChanged: c.filesChanged, finishedAt: c.finishedAt })),
    });
  }
  if (!commits.length) md.push('_No changes have landed yet._');

  return { markdown: md.join('\n'), groups: outGroups, totals, count: commits.length };
}
