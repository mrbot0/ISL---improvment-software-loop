import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, BASE_BRANCH, WORK_BRANCH } from '../config.js';
import { log } from '../logger.js';

/**
 * PULL-REQUEST PUBLISHER (ISL_IMPROVE §4 — plug into real dev workflows).
 *
 * ISL commits improvements to a work branch. To be useful to a real team, those changes
 * should arrive as a reviewable PR with the evidence attached, not a silent commit. This
 * module builds that PR body (what changed, the plan, the gates it passed, provenance) and:
 *   - opens a real PR on GitHub when GITHUB_TOKEN + GITHUB_REPO are configured, or
 *   - writes a draft to `.data/pr-drafts/` so the body is ready to use even offline.
 *
 * The formatting + draft always work here; the live GitHub call activates when configured,
 * so this is honest scaffolding, not a stub that pretends.
 */

const GITHUB = {
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '', // "owner/name"
  api: (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
};

export const githubConfigured = () => !!(GITHUB.token && GITHUB.repo);

/** Build the Markdown PR body from an iteration's outcome. */
export function buildPrBody({ iterationId, commitSha, title, total, scores = {}, provenance = '', filesChanged = 0, plan }) {
  const scoreLine = Object.entries(scores)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  return [
    `## ${title}`,
    '',
    `Autonomous improvement by **ISL** (iteration #${iterationId}). ${filesChanged} file(s) changed.`,
    '',
    `**Quality gates passed** — total ${total}/100${scoreLine ? ` (${scoreLine})` : ''}.`,
    '',
    tasks.length ? '### Tasks\n' + tasks.map((t) => `- **[${t.agent}]** ${t.title}`).join('\n') : '',
    '',
    provenance ? `### Provenance\n\`\`\`\n${provenance}\n\`\`\`` : '',
    '',
    `> Commit \`${String(commitSha).slice(0, 8)}\` on \`${WORK_BRANCH}\` → \`${BASE_BRANCH}\`.`,
    '> Every change passed regression, dead-code, security and safety vetoes before landing.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/** Write the PR body to a draft file (always works). Returns the path. */
function writeDraft(iterationId, commitSha, body) {
  const dir = path.join(DATA_DIR, 'pr-drafts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `iter-${iterationId}-${String(commitSha).slice(0, 8)}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** Open a real PR when GitHub is configured; best-effort. */
async function openGithubPr(title, body) {
  const res = await fetch(`${GITHUB.api}/repos/${GITHUB.repo}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${GITHUB.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body, head: WORK_BRANCH, base: BASE_BRANCH }),
  });
  if (!res.ok) throw new Error(`GitHub PR → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const pr = await res.json();
  return pr.html_url;
}

/**
 * Publish the change for a committed iteration: build the body, always write a draft, and
 * open a real PR if configured. Never throws into the pipeline.
 */
export async function publishPullRequest(data) {
  try {
    const title = `[ISL] ${data.title}`.slice(0, 120);
    const body = buildPrBody(data);
    const draft = writeDraft(data.iterationId, data.commitSha, body);
    if (githubConfigured()) {
      const url = await openGithubPr(title, body);
      log.info('pr', `opened PR for iteration #${data.iterationId}: ${url}`);
      return { opened: true, url, draft };
    }
    log.info('pr', `PR draft written for iteration #${data.iterationId}: ${draft} (set GITHUB_TOKEN + GITHUB_REPO to open a real PR)`);
    return { opened: false, draft };
  } catch (err) {
    log.warn('pr', `PR publish failed: ${err.message}`);
    return { opened: false, error: err.message };
  }
}
