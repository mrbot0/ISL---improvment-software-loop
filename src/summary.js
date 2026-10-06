import { listIterations, getIteration, listPhases } from './db_iteration.js';
import { llmText } from './iteration/llm.js';

/**
 * The "what actually landed" view. Every committed iteration is a real change on
 * the work branch, so the list of committed iterations IS the list of concrete
 * improvements the fleet has made. Each is selectable so an operator can zoom in
 * on a subset and get a plain-English summary of exactly what those commits did.
 */

export function landedCommits({ limit = 150 } = {}) {
  const iters = listIterations(limit);
  const commits = iters
    .filter((i) => (i.status === 'committed' || i.status === 'promoted') && i.commitSha)
    .map((i) => ({
      id: i.id,
      sha: (i.commitSha || '').slice(0, 8),
      title: i.planTitle || `Iteration #${i.id}`,
      status: i.status,
      score: i.scores?.total ?? null,
      filesChanged: i.filesChanged || 0,
      additions: i.additions || 0,
      deletions: i.deletions || 0,
      improvements: i.improvements || 0,
      features: i.featuresDone || 0,
      rolledBack: i.rolledBack,
      trigger: i.trigger,
      finishedAt: i.finishedAt,
    }));

  const totals = commits.reduce(
    (a, c) => ({
      commits: a.commits + 1,
      files: a.files + c.filesChanged,
      additions: a.additions + c.additions,
      deletions: a.deletions + c.deletions,
      improvements: a.improvements + c.improvements,
      features: a.features + c.features,
    }),
    { commits: 0, files: 0, additions: 0, deletions: 0, improvements: 0, features: 0 },
  );
  const scored = commits.filter((c) => c.score != null);
  totals.avgScore = scored.length ? Math.round(scored.reduce((a, c) => a + c.score, 0) / scored.length) : null;

  return { commits, totals };
}

/**
 * Human-readable summary of what a selected set of commits actually improved.
 * Grounded in each iteration's plan and its diff so it describes real changes,
 * not a guess.
 */
export async function describeCommits(ids, { signal } = {}) {
  const picked = (ids || [])
    .map((id) => getIteration(Number(id), { withDiff: true }))
    .filter(Boolean)
    .filter((i) => i.commitSha);

  if (!picked.length) return { summary: 'No committed iterations were selected.', count: 0 };

  const blocks = picked.map((i) => {
    const plan = i.plan || {};
    const tasks = Array.isArray(plan.tasks) ? plan.tasks.map((t) => `  · ${t.title}`).join('\n') : '';
    const diff = (i.diff || '').slice(0, 4000);
    return [
      `COMMIT ${(i.commitSha || '').slice(0, 8)} — ${i.planTitle || `Iteration #${i.id}`} (score ${i.scores?.total ?? '—'}, +${i.additions}/-${i.deletions} across ${i.filesChanged} file(s))`,
      plan.approach ? `Approach: ${plan.approach}` : '',
      tasks ? `Tasks:\n${tasks}` : '',
      diff ? `Diff (truncated):\n${diff}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  const system =
    'You are a release-notes writer for an autonomous code-improvement system. Given a set of ' +
    'committed changes (each with its plan and diff), write a concise, factual summary of the REAL ' +
    'improvements they made — grouped by theme (e.g. security, performance, tests, docs). Use short ' +
    'bullet points a reviewer can trust. Do not invent changes not present in the diffs.';
  const user = `Summarise what these ${picked.length} commit(s) actually improved:\n\n${blocks.join('\n\n---\n\n')}`;

  const { text } = await llmText({ system, user, temperature: 0.3, signal });
  return { summary: text, count: picked.length, commits: picked.map((i) => (i.commitSha || '').slice(0, 8)) };
}

/** A single commit's detail (plan + diff + phase scores) for the summary drawer. */
export function commitDetail(id) {
  const it = getIteration(Number(id), { withDiff: true });
  if (!it) return null;
  return {
    id: it.id,
    sha: it.commitSha,
    title: it.planTitle,
    plan: it.plan,
    diff: it.diff,
    scores: it.scores,
    filesChanged: it.filesChanged,
    additions: it.additions,
    deletions: it.deletions,
    phases: listPhases(it.id),
    finishedAt: it.finishedAt,
  };
}
