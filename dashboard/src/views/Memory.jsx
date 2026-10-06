import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { CardHead, Empty, PageHeader, Spinner, ago } from '../components/ui.jsx';

/**
 * Shared memory: what the fleet has learned. Errors and rejections become durable
 * lessons every agent and manager reads on the next run — the substrate of the
 * self-improvement loop. Operators can pin the important ones or prune noise.
 */
const KIND = {
  lesson: 'bg-sky-500/15 text-sky-300',
  pitfall: 'bg-rose-500/15 text-rose-300',
  fix: 'bg-emerald-500/15 text-emerald-300',
  pattern: 'bg-violet-500/15 text-violet-300',
  insight: 'bg-amber-500/15 text-amber-300',
};

const scopeLabel = (s) =>
  s === 'global' ? 'global' : s.startsWith('agent:') ? `🤖 ${s.slice(6)}` : s.startsWith('manager:') ? `⬢ ${s.slice(8)}` : s.startsWith('area:') ? `📁 ${s.slice(5)}` : s;

export default function Memory({ toast }) {
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);

  // Shared cache (instant paint on revisit) + 8s background refresh; `load` = refetch.
  const { data, refetch: load } = useResource('memory', () => api.memory(), { interval: 8000 });

  if (!data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const rows = data.list.filter((m) => !filter || m.scope === filter);
  const scopes = [...new Set(data.list.map((m) => m.scope))].sort();

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="🗃 Shared memory" subtitle="What the fleet has learned — durable lessons, patterns and pitfalls every agent reads on its next run." />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Memories" value={data.stats.total} />
        <Stat label="Pitfalls" value={data.stats.byKind?.pitfall || 0} tone="warn" />
        <Stat label="Fixes learned" value={data.stats.byKind?.fix || 0} tone="ok" />
        <Stat label="Agent-scoped" value={data.stats.byScope?.agent || 0} />
      </div>

      <CrossProject toast={toast} />

      <div className="card">
        <div className="card-head">
        <span className="card-title">Shared memory ({rows.length})</span>
<select aria-label="Filter memory by scope" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[11px]">
            <option value="">all scopes</option>
            {scopes.map((s) => <option key={s} value={s}>{scopeLabel(s)}</option>)}
          </select>
          <button onClick={() => setAdding((v) => !v)} className="btn-ghost">{adding ? '✕' : '＋ add'}</button>
        </div>

        {adding && <AddMemory onDone={() => { setAdding(false); load(); }} toast={toast} />}

        <div className="max-h-[65vh] divide-y divide-ink-800 overflow-y-auto">
          {rows.map((m) => (
            <div key={m.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className={`pill ${KIND[m.kind] || KIND.lesson}`}>{m.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-slate-200">{m.title}</span>
                  {m.uses > 1 && <span className="pill bg-ink-800 text-slate-400" title="times reinforced">×{m.uses}</span>}
                  {m.pinned && <span className="text-[10px] text-amber-400">📌</span>}
                </div>
                {m.content && <div className="mt-0.5 text-[11px] text-slate-400">{m.content}</div>}
                <div className="mt-0.5 text-[10px] text-slate-600">{scopeLabel(m.scope)} · {m.source || 'unknown'} · {ago(m.updatedAt)}</div>
              </div>
              <button onClick={() => api.pinMemory(m.id, !m.pinned).then(load)} className="btn-ghost" title={m.pinned ? 'Unpin' : 'Pin'}>{m.pinned ? '📌' : '📍'}</button>
              <button onClick={() => api.deleteMemory(m.id).then(load)} className="btn-ghost" title="Delete">✕</button>
            </div>
          ))}
          {!rows.length && <Empty icon="🧠" title="Nothing learned yet" hint="As agents fail, get rejected, or errors recur, the fleet records durable lessons here and reads them on the next run." />}
        </div>
      </div>
    </div>
  );
}

function AddMemory({ onDone, toast }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState('global');
  const [kind, setKind] = useState('lesson');
  const save = async () => {
    try {
      await api.addMemory({ title: title.trim(), content, scope, kind });
      toast?.('Added to shared memory', { type: 'success' });
      onDone();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  return (
    <div className="border-b border-ink-800 bg-ink-950/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input sm:col-span-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lesson / pitfall / fix (short title)" />
        <input className="input sm:col-span-2" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Detail (optional)" />
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="input">
          <option value="global">global (all agents)</option>
          {['security', 'tests', 'performance', 'quality', 'frontend', 'services', 'workbench', 'resilience', 'compliance', 'docs', 'infra', 'refactor', 'ux'].map((a) => (
            <option key={a} value={`agent:${a}`}>agent: {a}</option>
          ))}
          {['area:backend', 'area:frontend', 'area:services', 'area:infra'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="input">
          {['lesson', 'pitfall', 'fix', 'pattern', 'insight'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <div className="mt-2 flex justify-end">
        <button disabled={!title.trim()} onClick={save} className="btn-primary">Add</button>
      </div>
    </div>
  );
}

const Stat = ({ label, value, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'warn' ? 'text-amber-400' : tone === 'ok' ? 'text-emerald-400' : 'text-white'}`}>{value}</div>
  </div>
);

/**
 * Cross-project learning transfer — promote PROVEN patterns from one project into others whose
 * tech stack matches, so every project benefits from what any project learned. Deterministic
 * preview; the operator applies a transfer per pair.
 */
function CrossProject({ toast }) {
  const { data, refetch } = useResource('cross-project', () => api.crossProject(), { interval: 0 });
  const [busy, setBusy] = useState(null);
  if (!data) return null;

  const apply = async (pair) => {
    setBusy(`${pair.from}:${pair.to}`);
    try {
      const r = await api.applyCrossProject(pair.from, pair.to, 10);
      toast?.(`Transferred ${r.transferred} proven pattern(s) → ${pair.toName}`, { type: r.transferred ? 'success' : 'info' });
      refetch();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Cross-project learning transfer</span>
        <span className="ml-2 text-[11px] text-slate-500">promote proven patterns to stack-compatible projects</span>
      </div>
      <div className="flex flex-wrap gap-2 px-3 py-2 text-[11px] text-slate-500">
        {(data.projects || []).map((p) => (
          <span key={p.id} className="pill bg-ink-800 text-slate-400">{p.name} · [{p.stack.join(', ') || 'stack unknown'}] · {p.patterns} proven</span>
        ))}
      </div>
      <div className="divide-y divide-ink-800">
        {(data.pairs || []).map((pair, i) => (
          <div key={i} className="px-3 py-2.5">
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-slate-200">{pair.fromName} <span className="text-slate-600">→</span> {pair.toName}</span>
              <span className="pill bg-emerald-500/15 text-emerald-300">{pair.similarity}% stack match</span>
              <span className="text-[11px] text-slate-500">{pair.candidateCount} transferable</span>
              <div className="flex-1" />
              <button disabled={busy === `${pair.from}:${pair.to}`} onClick={() => apply(pair)} className="btn-primary text-[11px]">
                {busy === `${pair.from}:${pair.to}` ? '…' : 'Transfer'}
              </button>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-600">
              {pair.candidates.slice(0, 5).map((c, j) => <span key={j}>[{c.kind}×{c.uses}] {c.title.slice(0, 44)}</span>)}
            </div>
          </div>
        ))}
        {!data.pairs.length && (
          <div className="px-3 py-4 text-[12px] text-slate-500">
            No transferable pairs yet — a project needs proven patterns (reinforced ≥2×) and a known stack that overlaps another project's.
          </div>
        )}
      </div>
    </div>
  );
}
