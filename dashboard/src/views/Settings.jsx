import { useEffect, useState } from 'react';
import { api } from '../api.js';
import ScheduleGrid from '../components/ScheduleGrid.jsx';
import { accentHex } from '../components/charts.jsx';
import { Spinner } from '../components/ui.jsx';
import ModelsPanel from '../components/ModelsPanel.jsx';

const Section = ({ title, desc, children }) => (
  <div className="card p-5">
    <h3 className="text-sm font-semibold text-white">{title}</h3>
    {desc && <p className="mt-0.5 text-[11px] text-slate-500">{desc}</p>}
    <div className="mt-4">{children}</div>
  </div>
);

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="mb-1 block text-[11px] font-medium text-slate-400">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[10px] text-slate-600">{hint}</span>}
  </label>
);

const Toggle = ({ on, onClick, label }) => (
  <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-ink-700'}`}>
    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
  </button>
);

const WEIGHTS = [
  { key: 'weight.review', label: 'Review', accent: 'sky' },
  { key: 'weight.security', label: 'Security', accent: 'rose' },
  { key: 'weight.regression', label: 'Regression', accent: 'amber' },
  { key: 'weight.test', label: 'Test', accent: 'emerald' },
];

/**
 * The full Settings page: everything that used to hide in the header dropdown,
 * plus iteration controls, KPI weights, model/health info, theme, and a danger
 * zone — one place to configure the whole system.
 */
export default function Settings({ orchestrator, iteration, actions, theme, toggleTheme, toast }) {
  const ctrl = iteration?.controller;
  const [health, setHealth] = useState(null);
  const [maxPending, setMaxPending] = useState(orchestrator?.fleet?.maxPending ?? 20);
  const [applyMode, setApplyMode] = useState(orchestrator?.applyMode ?? 'branch');
  const [iterInterval, setIterInterval] = useState(ctrl?.intervalSeconds ?? 120);
  const [parallel, setParallel] = useState(ctrl?.parallel?.maxTasks ?? 2);
  const [improvements, setImprovements] = useState(ctrl?.batch?.improvements ?? 3);
  const [features, setFeatures] = useState(ctrl?.batch?.features ?? 2);
  const [kpi, setKpi] = useState(iteration?.kpi || {});
  const [kpiDirty, setKpiDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);
  useEffect(() => {
    if (!kpiDirty) setKpi(iteration?.kpi || {});
  }, [iteration?.kpi, kpiDirty]);

  const guard = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const setK = (k, v) => {
    setKpi((d) => ({ ...d, [k]: v }));
    setKpiDirty(true);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3 pb-8">
      {/* The one pipeline */}
      <Section
        title="The pipeline"
        desc="One loop: plan a batch → route each task to its specialist → implement in parallel → grade → boot the app → commit. There is no second engine to configure."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Interval (s)" hint="between iterations">
            <input type="number" min="30" value={iterInterval} onChange={(e) => setIterInterval(+e.target.value)} className="input" />
          </Field>
          <Field label="Work branch" hint="where passing iterations land">
            <input value={ctrl?.workBranch || ''} readOnly className="input opacity-70" />
          </Field>
          <Field label="Today" hint="daily cap">
            <input value={`${ctrl?.todayCount ?? 0} / ${ctrl?.maxPerDay ?? 50}`} readOnly className="input opacity-70" />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => guard(() => actions.setControl({ intervalSeconds: iterInterval }))}>save</button>
          {ctrl?.looping ? (
            <button className="btn-danger" onClick={() => guard(actions.stopLoop)}>■ stop</button>
          ) : (
            <button className="btn-ghost" onClick={() => guard(actions.startLoop)}>▶ start loop</button>
          )}
          <button className="btn-ghost" disabled={ctrl?.running} onClick={() => guard(actions.runIteration)}>↻ run one</button>
          <span className="text-[11px] text-slate-500">
            {ctrl?.looping ? 'running' : 'stopped'}
            {ctrl?.restartable?.length ? ` · ${ctrl.restartable.length} restartable` : ''}
          </span>
        </div>
      </Section>

      <ModelsPanel toast={toast} />

      <ImprovementWindows toast={toast} />

      {/* Parallelism & batch */}
      <Section
        title="Parallelism & batch size"
        desc="Tasks that touch no common file run at the same time, each in its own sandbox. The model itself stays behind a semaphore, so widening this never oversubscribes the GPU — it lets one task run its tests while another thinks."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Tasks in parallel" hint="1 = strictly serial. 2–3 is the sweet spot on one GPU.">
            <input type="number" min="1" max="6" value={parallel} onChange={(e) => setParallel(+e.target.value)} className="input" />
          </Field>
          <Field label="Improvements per iteration" hint="hotspot functions to fix each run">
            <input type="number" min="0" max="8" value={improvements} onChange={(e) => setImprovements(+e.target.value)} className="input" />
          </Field>
          <Field label="Features per iteration" hint="backlog features to build each run">
            <input type="number" min="0" max="6" value={features} onChange={(e) => setFeatures(+e.target.value)} className="input" />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => guard(() => actions.setControl({ parallelism: parallel, improvements, features }))}
          >
            save
          </button>
          <span className="text-[11px] text-slate-500">
            in flight now: {ctrl?.parallel?.llmInFlight ?? 0} generation(s), {ctrl?.parallel?.llmQueued ?? 0} queued
          </span>
        </div>
      </Section>

      {/* Review fleet */}
      <Section
        title="Review fleet"
        desc="The specialists can also be run one-off as a review pass: they produce proposals for you to approve instead of committing. This no longer has a loop of its own."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max pending" hint="the pipeline pauses past this review backlog">
            <input type="number" min="1" value={maxPending} onChange={(e) => setMaxPending(+e.target.value)} className="input" />
          </Field>
          <Field label="Apply mode" hint="branch = commit to agents/*; direct = working tree">
            <select value={applyMode} onChange={(e) => setApplyMode(e.target.value)} className="input">
              <option value="branch">branch (safe)</option>
              <option value="direct">direct</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => guard(() => actions.settings({ maxPending, applyMode }))}>save</button>
          <span className="text-[11px] text-slate-500">{ctrl?.fleet?.pending ?? 0} awaiting review</span>
        </div>
      </Section>

      {/* Score weights */}
      <Section title="Score weights & thresholds" desc="How an iteration's total score is computed. Applies to the next iteration.">
        <div className="space-y-3">
          {WEIGHTS.map((w) => {
            const val = Number(kpi[w.key]) || 0;
            return (
              <div key={w.key}>
                <div className="mb-1 flex justify-between text-[12px]">
                  <span className="text-slate-300">{w.label}</span>
                  <span className="font-mono" style={{ color: accentHex(w.accent) }}>{Math.round(val * 100)}%</span>
                </div>
                <input type="range" min="0" max="1" step="0.05" value={val} onChange={(e) => setK(w.key, +e.target.value)} className="w-full" style={{ accentColor: accentHex(w.accent) }} />
              </div>
            );
          })}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Rollback threshold"><input type="number" min="0" max="100" value={kpi.rollback_threshold ?? 60} onChange={(e) => setK('rollback_threshold', +e.target.value)} className="input" /></Field>
          <Field label="Improvements / iter"><input type="number" min="0" max="6" value={kpi.improvements_per_iter ?? 2} onChange={(e) => setK('improvements_per_iter', +e.target.value)} className="input" /></Field>
          <Field label="Features / iter"><input type="number" min="0" max="4" value={kpi.features_per_iter ?? 1} onChange={(e) => setK('features_per_iter', +e.target.value)} className="input" /></Field>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button className="btn-primary" disabled={!kpiDirty || busy} onClick={() => guard(async () => { await actions.setKpi(kpi); setKpiDirty(false); })}>save KPI</button>
          {kpiDirty && <span className="text-[11px] text-amber-400">unsaved</span>}
        </div>
      </Section>

      {/* Appearance */}
      <Section title="Appearance" desc="Personalise the console.">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] text-slate-200">Theme</div>
            <div className="text-[11px] text-slate-500">currently {theme}</div>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-slate-400">
            <span>dark</span>
            <Toggle on={theme === 'light'} onClick={toggleTheme} label="Toggle light theme" />
            <span>light</span>
          </div>
        </div>
      </Section>

      {/* System / model */}
      <Section title="System" desc="Runtime and model information.">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
          <Row label="Ollama" value={health?.ollama?.ok ? 'reachable' : health?.ollama?.error || '…'} ok={health?.ollama?.ok} />
          <Row label="Model" value={health?.ollama?.model || '…'} mono />
          <Row label="Chat model" value={health?.ollama?.chatModel || '…'} mono />
          <Row label="Branch" value={health?.repo?.branch || '…'} mono />
          <Row label="HEAD" value={health?.repo?.head || '…'} mono />
          <Row label="Working tree" value={health?.repo?.dirty ? 'dirty' : 'clean'} ok={!health?.repo?.dirty} />
        </dl>
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost" onClick={actions.refetch}>↻ refresh state</button>
          <button className="btn-ghost" onClick={() => api.report().then((r) => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a'); a.href = url; a.download = 'isl-agents-report.json'; a.click(); URL.revokeObjectURL(url);
          })}>⭳ export report</button>
        </div>
      </Section>
    </div>
  );
}

const Row = ({ label, value, ok, mono }) => (
  <div className="flex items-center justify-between border-b border-ink-800/60 pb-1.5">
    <dt className="text-slate-500">{label}</dt>
    <dd className={`flex items-center gap-1.5 ${mono ? 'font-mono text-[11px]' : ''} ${ok === undefined ? 'text-slate-300' : ok ? 'text-emerald-400' : 'text-rose-400'}`}>
      {ok !== undefined && <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />}
      {value}
    </dd>
  </div>
);

/**
 * Scheduled improvement windows. The controls now live in ScheduleGrid, which adds the week × hour
 * view — four numbers do not tell you when maintenance actually fires, and an overnight window
 * (22 → 05) puts the early hours on the PREVIOUS day's selection, which no sentence makes obvious.
 */
function ImprovementWindows({ toast }) {
  return (
    <Section title="Scheduled improvement windows" desc="Run heavier passes during quiet hours — each task at most once per day, rate-limited and dedup-safe. Off by default.">
      <ScheduleGrid toast={toast} />
    </Section>
  );
}
