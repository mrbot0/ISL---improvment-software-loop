/**
 * The single source of truth for the dashboard navigation. Both the sidebar (App)
 * and the admin's Dashboard-control editor read this catalog, so what the admin can
 * toggle is exactly what the sidebar renders.
 */
export function navCatalog(isAdmin) {
  const groups = [
    {
      title: 'Workspace',
      items: [
        { id: 'overview', label: 'Overview', icon: '▤' },
        // "What is happening" (Overview) and "is it helping" (Insight) are different questions;
        // they sit next to each other rather than being merged into one crowded page.
        { id: 'insight', label: 'Insight', icon: '✨' },
        { id: 'projects', label: 'Projects', icon: '⊞' },
        { id: 'context', label: 'Context', icon: '📚' },
        { id: 'explorer', label: 'Explorer', icon: '◧' },
      ],
    },
    {
      title: 'Improve',
      items: [
        { id: 'scope', label: 'Scope', icon: '🎯' },
        // Runs absorbs Iterations and Flow: the same run seen as a list, a detail and a live
        // timeline. Following one used to mean moving between three pages. See `merged.js`.
        { id: 'runs', label: 'Runs', icon: '⟳' },
        { id: 'plans', label: 'Plans', icon: '◈' },
        { id: 'backlog', label: 'Backlog', icon: '☰' },
        { id: 'proposals', label: 'Proposals', icon: '◆' },
        { id: 'summary', label: 'Summary', icon: '✔' },
      ],
    },
    {
      title: 'Fleet',
      items: [
        { id: 'fleet', label: 'Agents', icon: '⬡' },
        { id: 'managers', label: 'Managers', icon: '⬢' },
        { id: 'review', label: 'Review', icon: '☑' },
        // Security absorbs Compliance and Governance — the diff gate, the best-practice rules and
        // the policy are three faces of "what is allowed".
        { id: 'security', label: 'Security & Rules', icon: '🔒' },
        { id: 'reliability', label: 'Reliability', icon: '🩺' },
        { id: 'models', label: 'Models', icon: '🧠' },
        // Memory absorbs Decisions: what the fleet knows, and how that knowledge routes work.
        { id: 'memory', label: 'Memory', icon: '🗃' },
      ],
    },
    {
      title: 'Deploy',
      items: [
        { id: 'services', label: 'Services', icon: '🔗' },
        // Workbench absorbs Repair: the boot check as a gate inside a run, and the same check on
        // demand with a repair attempt. One question, two moments.
        { id: 'workbench', label: 'Workbench', icon: '🔧' },
        { id: 'runtime', label: 'Runtime', icon: '🐳' },
        { id: 'deploy', label: 'Promote', icon: '⬆' },
        { id: 'cloud', label: 'Cloud', icon: '☁' },
      ],
    },
    {
      title: 'Insight',
      items: [
        { id: 'digest', label: 'Digest', icon: '📰' },
        // Health absorbs Analytics and Telemetry — three pages of read-only measurement. KPI stays
        // its own entry: it is configuration, not a report. Named "Metrics", not "Insights": this
        // group is already called Insight and so is a page in Workspace, and three near-identical
        // labels in one menu is a worse problem than the one the merge set out to solve.
        { id: 'health', label: 'Metrics', icon: '🩹' },
        { id: 'kpi', label: 'KPI', icon: '◎' },
        { id: 'logs', label: 'Logs', icon: '≣' },
        { id: 'notifications', label: 'Notifications', icon: '◔' },
        { id: 'settings', label: 'Settings', icon: '⚙' },
      ],
    },
  ];
  if (isAdmin) groups.push({ title: 'Administration', items: [{ id: 'admin', label: 'Admin', icon: '⛨' }] });
  return groups;
}

// Items the admin may never hide (they'd lose the way back to un-hide anything).
export const UNHIDEABLE = new Set(['overview', 'admin']);

/**
 * Apply the admin's dashboard config to the catalog: drop hidden items, rename via
 * labels. Admin-only items (the Admin page) are always kept for admins.
 */
export function applyDashboardConfig(isAdmin, cfg = {}) {
  const hidden = new Set((cfg.hidden || []).filter((id) => !UNHIDEABLE.has(id)));
  const labels = cfg.labels || {};
  return navCatalog(isAdmin)
    .map((g) => ({
      ...g,
      items: g.items
        .filter((it) => !hidden.has(it.id))
        .map((it) => ({ ...it, label: labels[it.id]?.trim() || it.label })),
    }))
    .filter((g) => g.items.length);
}
