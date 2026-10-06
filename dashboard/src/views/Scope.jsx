import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SAFETY_NET_MS } from '../liveKeys.js';
import { Resource } from '../components/Resource.jsx';
import { useResource } from '../hooks.js';
import { CardHead, PageHeader } from '../components/ui.jsx';

/**
 * 🎯 Improvement Scope — the human's steering wheel.
 *
 * Left alone the fleet drifts toward whatever is easiest to land (in practice: unit tests). This is
 * where a person decides what the loop, the agents, the managers and the online research must
 * actually focus on: a weight per theme, a hard cap so no theme can dominate, free-text directives,
 * exclusions, and what research should look for. "Intent vs reality" shows the drift honestly.
 */
const ORDER = ['ux', 'frontend', 'backend', 'architecture', 'security', 'performance', 'tests', 'docs', 'infra'];
const BAR = {
  ux: 'bg-violet-500', frontend: 'bg-sky-500', backend: 'bg-emerald-500', architecture: 'bg-teal-500',
  security: 'bg-rose-500', performance: 'bg-amber-500', tests: 'bg-slate-500', docs: 'bg-slate-600', infra: 'bg-indigo-500',
};

const PRESETS = {
  'Product & UX push': { focus: { ux: 35, frontend: 25, backend: 20, architecture: 10, security: 5, performance: 3, tests: 2, docs: 0, infra: 0 }, caps: { tests: 15 } },
  'Architecture & backend': { focus: { architecture: 30, backend: 30, performance: 15, security: 10, frontend: 5, ux: 5, tests: 5, docs: 0, infra: 0 }, caps: { tests: 20 } },
  'Harden & secure': { focus: { security: 35, backend: 20, performance: 15, architecture: 10, tests: 10, infra: 10, ux: 0, frontend: 0, docs: 0 }, caps: { tests: 30 } },
  'Balanced (default)': { focus: { ux: 20, frontend: 20, backend: 20, architecture: 15, security: 10, performance: 5, tests: 5, docs: 3, infra: 2 }, caps: { tests: 25, docs: 15 } },
};

export default function Scope({ toast }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // `scope` is shared with the top bar, so both read one cached copy instead of asking twice.
  const res = useResource('scope', api.scope, { interval: SAFETY_NET_MS });
  const { data, refetch: load } = res;
  // The editable form is seeded from the fetched scope the first time it arrives.
  useEffect(() => { if (data?.scope && !form) setForm(data.scope); }, [data]);
  if (!data || !form) return <div className="p-4"><Resource {...res} rows={4} emptyTitle="No scope configured" /></div>;

  const themes = data.themes;
  const total = ORDER.reduce((s, k) => s + (form.exclude.includes(k) ? 0 : Number(form.focus[k]) || 0), 0) || 1;
  const pct = (k) => (form.exclude.includes(k) ? 0 : Math.round(((Number(form.focus[k]) || 0) / total) * 100));
  const dirty = JSON.stringify(form) !== JSON.stringify(data.scope);

  const setFocus = (k, v) => setForm({ ...form, focus: { ...form.focus, [k]: Math.max(0, Math.min(100, Number(v) || 0)) } });
  const setCap = (k, v) => {
    const caps = { ...form.caps };
    if (v === '' || v == null) delete caps[k]; else caps[k] = Math.max(1, Math.min(100, Number(v) || 1));
    setForm({ ...form, caps });
  };
  const toggleExclude = (k) => setForm({ ...form, exclude: form.exclude.includes(k) ? form.exclude.filter((x) => x !== k) : [...form.exclude, k] });

  const save = async () => {
    setSaving(true);
    try { await api.setScope(form); await load(); toast?.('Scope updated — the loop, agents, managers and research now follow it', { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
    finally { setSaving(false); }
  };
  const reset = async () => {
    if (!window.confirm('Reset the improvement scope to the balanced default?')) return;
    setSaving(true);
    try { await api.resetScope(); await load(); toast?.('Scope reset', { type: 'info' }); }
    finally { setSaving(false); }
  };
  const applyPreset = (name) => setForm({ ...form, focus: { ...form.focus, ...PRESETS[name].focus }, caps: { ...PRESETS[name].caps }, exclude: [] });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="🎯 Improvement scope"
        subtitle="You decide what the fleet works on. This focus governs the planner's batch composition, every agent's brief, the managers and the online research — so improvement goes where you want it, not just where it's easiest."
      >
        <div className="flex gap-1">
          <button onClick={reset} disabled={saving} className="btn-ghost text-[11px]">reset</button>
          <button onClick={save} disabled={saving || !dirty} className="btn-primary text-[11px]">{saving ? '…' : dirty ? 'Save scope' : 'Saved'}</button>
        </div>
      </PageHeader>

      {/* Enforcement */}
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <button
          onClick={() => setForm({ ...form, enforce: !form.enforce })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${form.enforce ? 'bg-emerald-500' : 'bg-ink-700'}`}
          role="switch" aria-checked={!!form.enforce} aria-label="Enforce scope"
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${form.enforce ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
        <div className="min-w-0 flex-1 text-[12px]">
          <span className="font-medium text-slate-200">{form.enforce ? 'Enforced' : 'Advisory only'}</span>
          <span className="ml-2 text-slate-500">
            {form.enforce
              ? 'the planner re-weights and caps the batch — a theme cannot dominate just because it lands easily'
              : 'the scope is only injected as guidance text; the planner does not shape the batch'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.keys(PRESETS).map((p) => (
            <button key={p} onClick={() => applyPreset(p)} className="pill bg-ink-800 text-slate-300 hover:text-white">{p}</button>
          ))}
        </div>
      </div>

      {/* Focus mix */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Focus mix</span>
          <span className="ml-2 text-[11px] text-slate-500">weight per theme · cap = max share of one batch</span>
        </div>

        {/* stacked bar */}
        <div className="flex h-2.5 overflow-hidden rounded-full bg-ink-900 mx-3 mt-3">
          {ORDER.map((k) => pct(k) > 0 && <div key={k} className={BAR[k]} style={{ width: `${pct(k)}%` }} title={`${themes[k]?.label} ${pct(k)}%`} />)}
        </div>

        <div className="divide-y divide-ink-800 mt-2">
          {ORDER.map((k) => {
            const excluded = form.exclude.includes(k);
            return (
              <div key={k} className={`flex flex-wrap items-center gap-3 px-3 py-2 ${excluded ? 'opacity-45' : ''}`}>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${BAR[k]}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-slate-200">{themes[k]?.label || k}</div>
                  <div className="truncate text-[10px] text-slate-600">{themes[k]?.hint}</div>
                </div>
                <input
                  type="range" min="0" max="50" value={form.focus[k] ?? 0} disabled={excluded}
                  onChange={(e) => setFocus(k, e.target.value)} className="w-32 accent-brand"
                  aria-label={`${themes[k]?.label} weight`}
                />
                <span className="w-10 text-right text-[12px] tabular-nums text-slate-300">{pct(k)}%</span>
                <label className="flex items-center gap-1 text-[10px] text-slate-500">
                  cap
                  <input
                    type="number" min="1" max="100" placeholder="—" value={form.caps[k] ?? ''}
                    onChange={(e) => setCap(k, e.target.value)}
                    className="w-14 rounded border border-ink-800 bg-ink-950/60 px-1 py-0.5 text-[11px] text-slate-200"
                  />
                </label>
                <button onClick={() => toggleExclude(k)} className={`pill ${excluded ? 'bg-rose-500/15 text-rose-300' : 'bg-ink-800 text-slate-500'}`}>
                  {excluded ? 'excluded' : 'exclude'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Intent vs reality */}
      {data.actual && (
        <div className="card p-3">
          <div className="card-title mb-2">Intent vs. reality</div>
          <p className="mb-2 text-[11px] text-slate-500">What you asked for, against what the fleet has actually landed so far. A large gap means the scope was not being followed — it is now.</p>
          <div className="space-y-1.5">
            {ORDER.filter((k) => pct(k) > 0 || (data.actual[k] || 0) > 0).map((k) => (
              <div key={k} className="flex items-center gap-2 text-[11px]">
                <span className="w-28 shrink-0 truncate text-slate-400">{themes[k]?.label}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-900"><div className={BAR[k]} style={{ width: `${pct(k)}%`, height: '100%' }} /></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-900"><div className="h-full bg-slate-600" style={{ width: `${data.actual[k] || 0}%` }} /></div>
                </div>
                <span className="w-24 shrink-0 text-right tabular-nums text-slate-500">{pct(k)}% <span className="text-slate-700">vs</span> {data.actual[k] || 0}%</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-slate-600">top bar = your intent · bottom bar = landed work</div>
        </div>
      )}

      {/* Directives */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-3">
          <div className="card-title mb-1">Directives to the fleet</div>
          <p className="mb-2 text-[11px] text-slate-500">Injected verbatim into the planner, every agent's brief and the managers. Be concrete: name the flow, the screen, the outcome.</p>
          <textarea
            value={form.directives} onChange={(e) => setForm({ ...form, directives: e.target.value })}
            rows={6} placeholder={'e.g. Redesign the booking flow: fewer steps to confirm, clear price breakdown, visible cancellation policy.\nMake the item page load under 1s on mobile.\nNo more test-only iterations — every batch must change something a user or an operator can see.'}
            className="w-full rounded-lg border border-ink-800 bg-ink-950/60 p-2 text-[12px] text-slate-200 outline-none placeholder:text-slate-600"
          />
        </div>
        <div className="card p-3">
          <div className="card-title mb-1">What research should look for</div>
          <p className="mb-2 text-[11px] text-slate-500">Steers the online research so proposals match your direction instead of generic best practices.</p>
          <textarea
            value={form.research} onChange={(e) => setForm({ ...form, research: e.target.value })}
            rows={6} placeholder={'e.g. how leading rental marketplaces design trust & reviews; checkout patterns that reduce abandonment; mobile-first listing pages.'}
            className="w-full rounded-lg border border-ink-800 bg-ink-950/60 p-2 text-[12px] text-slate-200 outline-none placeholder:text-slate-600"
          />
        </div>
      </div>

      {/* Exactly what the fleet reads */}
      <div className="card p-3">
        <div className="card-title mb-1">What the fleet will read</div>
        <p className="mb-2 text-[11px] text-slate-500">This exact text goes to the planner, every agent and the researcher — no interpretation in between.</p>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950/60 p-3 text-[11px] leading-relaxed text-slate-300">{data.brief}</pre>
        {dirty && <div className="mt-2 text-[11px] text-amber-400">Unsaved changes — save to apply them to the fleet.</div>}
      </div>
    </div>
  );
}
