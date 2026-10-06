import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Resource } from '../components/Resource.jsx';
import { useResource } from '../hooks.js';
import { Empty, Spinner, Churn, ago } from '../components/ui.jsx';

/**
 * Summary of what actually shipped. Every committed iteration is a real change on
 * the work branch; select any subset to get a plain-English description of what
 * those commits improved, grounded in their plans and diffs.
 */
export default function Summary({ toast }) {
  const [selected, setSelected] = useState(() => new Set());
  const [describing, setDescribing] = useState(false);
  const [summary, setSummary] = useState(null);
  const [detail, setDetail] = useState(null);
  const [changelog, setChangelog] = useState(null);
  const [showNotes, setShowNotes] = useState(false);

  const res = useResource('summary:commits', api.summaryCommits, { interval: SAFETY_NET_MS });
  const data = res.data;
  useEffect(() => {
    api.changelog().then(setChangelog).catch(() => {});
  }, []);

  const copyNotes = () => {
    if (!changelog?.markdown) return;
    navigator.clipboard?.writeText(changelog.markdown).then(
      () => toast?.('Release notes copied', { type: 'success' }),
      () => toast?.('Copy failed', { type: 'error' }),
    );
  };

  if (!data) return <div className="p-4"><Resource {...res} rows={5} emptyTitle="No commits to summarise" /></div>;

  const { commits, totals } = data;
  const toggle = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    setSummary(null);
  };
  const allSelected = commits.length > 0 && selected.size === commits.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(commits.map((c) => c.id)));
    setSummary(null);
  };

  const sel = commits.filter((c) => selected.has(c.id));
  const selTotals = sel.reduce(
    (a, c) => ({ files: a.files + c.filesChanged, add: a.add + c.additions, del: a.del + c.deletions, impr: a.impr + c.improvements, feat: a.feat + c.features }),
    { files: 0, add: 0, del: 0, impr: 0, feat: 0 },
  );

  const describe = async () => {
    setDescribing(true);
    setSummary(null);
    try {
      const r = await api.describeCommits([...selected]);
      setSummary(r.summary);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setDescribing(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Landed commits" value={totals.commits} />
        <Stat label="Files changed" value={totals.files} />
        <Stat label="Net churn" value={`+${totals.additions}/−${totals.deletions}`} />
        <Stat label="Avg score" value={totals.avgScore != null ? `${totals.avgScore}` : '—'} suffix={totals.avgScore != null ? '/100' : ''} />
      </div>

      {/* Auto-generated release notes (theme-grouped, from landed commits) */}
      {changelog && changelog.count > 0 && (
        <div className="card">
          <div className="card-head">
            <button onClick={() => setShowNotes((v) => !v)} className="card-title flex items-center gap-1 hover:text-white">
              <span>{showNotes ? '▾' : '▸'}</span> Release notes
              <span className="ml-1 text-[11px] font-normal text-slate-500">{changelog.count} changes · {changelog.groups.length} themes</span>
            </button>
            <div className="flex-1" />
            <button onClick={copyNotes} className="btn-ghost text-[11px]">⧉ copy markdown</button>
          </div>
          {showNotes && (
            <div className="max-h-[50vh] space-y-3 overflow-y-auto px-3 py-3">
              {changelog.groups.map((g) => (
                <div key={g.theme}>
                  <div className="text-[12px] font-semibold text-slate-200">{g.theme} <span className="text-slate-500">({g.count})</span></div>
                  <ul className="mt-1 space-y-0.5">
                    {g.items.map((it) => (
                      <li key={it.id} className="flex items-start gap-2 text-[11px] text-slate-400">
                        <span className="font-mono text-slate-600">{it.sha}</span>
                        <span className="min-w-0 flex-1">{it.title}</span>
                        {it.score != null && <span className="pill bg-ink-800 text-slate-500">{it.score}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <button onClick={toggleAll} className="text-[11px] text-slate-400 hover:text-slate-200">
            {allSelected ? '☑' : '☐'} {selected.size ? `${selected.size} selected` : 'select all'}
          </button>
          <div className="flex-1" />
          {selected.size > 0 && (
            <span className="text-[10px] text-slate-500">
              {selTotals.files} files · +{selTotals.add}/−{selTotals.del} · {selTotals.impr} impr · {selTotals.feat} feat
            </span>
          )}
          <button disabled={!selected.size || describing} onClick={describe} className="btn-primary">
            {describing ? <Spinner /> : '✦'} Describe selected
          </button>
        </div>

        {summary && (
          <div className="border-b border-ink-800 bg-ink-950/40 px-4 py-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">What these {selected.size} commit(s) improved</div>
            <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300">{summary}</div>
          </div>
        )}

        <div className="divide-y divide-ink-800">
          {commits.map((c) => (
            <div key={c.id} className={`flex items-center gap-3 px-3 py-2.5 ${selected.has(c.id) ? 'bg-brand/5' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="h-3.5 w-3.5 accent-brand"
                aria-label={`Select commit ${c.sha} — ${c.title}`}
              />
              <span className="font-mono text-[11px] text-slate-500">{c.sha}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-slate-200">{c.title}</div>
                <div className="flex items-center gap-2 text-[10px] text-slate-600">
                  <span>{ago(c.finishedAt)}</span>
                  {c.improvements > 0 && <span>· {c.improvements} impr</span>}
                  {c.features > 0 && <span>· {c.features} feat</span>}
                  {c.rolledBack && <span className="text-amber-400">· rolled back</span>}
                </div>
              </div>
              <Churn additions={c.additions} deletions={c.deletions} />
              {c.score != null && (
                <span className={`pill ${c.score >= 75 ? 'bg-emerald-500/15 text-emerald-300' : c.score >= 50 ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300'}`}>
                  {c.score}
                </span>
              )}
              <button onClick={() => api.commitDetail(c.id).then(setDetail).catch(() => {})} className="btn-ghost">diff</button>
            </div>
          ))}
          {!commits.length && <Empty icon="◆" title="Nothing landed yet" hint="Committed iterations appear here as the loop lands improvements on the work branch." />}
        </div>
      </div>

      {detail && <CommitDrawer detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CommitDrawer({ detail, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="flex h-full w-[720px] max-w-full flex-col border-l border-ink-800 bg-ink-950" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
          <span className="font-mono text-[11px] text-slate-500">{(detail.sha || '').slice(0, 8)}</span>
          <span className="truncate text-[13px] font-semibold text-slate-200">{detail.title || `Iteration #${detail.id}`}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {detail.plan?.approach && (
            <div className="mb-3">
              <div className="stat-label">Approach</div>
              <p className="mt-0.5 text-[12px] text-slate-300">{detail.plan.approach}</p>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-950">
            <pre className="min-w-full font-mono text-[11px] leading-[1.5]">
              {(detail.diff || '(no diff)').split('\n').map((l, i) => (
                <div
                  key={i}
                  className={`px-3 ${
                    l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : 'diff-meta'
                  }`}
                >
                  {l || ' '}
                </div>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

const Stat = ({ label, value, suffix }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className="stat mt-1 text-white">{value}<span className="text-sm text-slate-600">{suffix}</span></div>
  </div>
);
