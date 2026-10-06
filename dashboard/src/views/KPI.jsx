import { useEffect, useState } from 'react';
import { accentHex } from '../components/charts.jsx';

const WEIGHTS = [
  { key: 'weight.review', label: 'Review', accent: 'sky' },
  { key: 'weight.security', label: 'Security', accent: 'rose' },
  { key: 'weight.regression', label: 'Regression', accent: 'amber' },
  { key: 'weight.test', label: 'Test', accent: 'emerald' },
];

/**
 * KPI controls: the weights that combine into an iteration's total score, the
 * rollback threshold, and the per-iteration work budget. Changes take effect on
 * the next iteration.
 */
export default function KPI({ iteration, actions }) {
  const kpi = iteration?.kpi || {};
  const [draft, setDraft] = useState(kpi);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(kpi);
  }, [kpi, dirty]);

  const set = (k, v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const weightSum = WEIGHTS.reduce((a, w) => a + (Number(draft[w.key]) || 0), 0);

  const save = async () => {
    await actions.setKpi(draft);
    setDirty(false);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <div className="card p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Score weights</h2>
          <span className={`text-[11px] ${Math.abs(weightSum - 1) < 0.001 ? 'text-slate-500' : 'text-amber-400'}`}>
            sum {weightSum.toFixed(2)}{Math.abs(weightSum - 1) > 0.001 ? ' (auto-normalized)' : ''}
          </span>
        </div>
        <p className="mb-4 text-[11px] text-slate-500">
          How each phase contributes to an iteration's total score. Total below the rollback threshold → the iteration is reverted.
        </p>
        <div className="space-y-4">
          {WEIGHTS.map((w) => {
            const val = Number(draft[w.key]) || 0;
            return (
              <div key={w.key}>
                <div className="mb-1 flex items-center justify-between text-[12px]">
                  <span className="font-medium text-slate-300">{w.label}</span>
                  <span className="font-mono" style={{ color: accentHex(w.accent) }}>{Math.round(val * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={val}
                  onChange={(e) => set(w.key, Number(e.target.value))}
                  className="w-full"
                  style={{ accentColor: accentHex(w.accent) }}
                  aria-label={`${w.label} weight`}
                  aria-valuetext={`${Math.round(val * 100)} percent`}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberCard label="Rollback threshold" hint="total score below this reverts" value={draft.rollback_threshold} onChange={(v) => set('rollback_threshold', v)} min={0} max={100} />
        <NumberCard label="Improvements / iter" hint="functions targeted per run" value={draft.improvements_per_iter} onChange={(v) => set('improvements_per_iter', v)} min={0} max={6} />
        <NumberCard label="Features / iter" hint="backlog items per run" value={draft.features_per_iter} onChange={(v) => set('features_per_iter', v)} min={0} max={4} />
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!dirty} onClick={save}>save KPI settings</button>
        {dirty && <button className="btn-ghost" onClick={() => { setDraft(kpi); setDirty(false); }}>reset</button>}
        {dirty && <span className="text-[11px] text-amber-400">unsaved changes — applies to the next iteration</span>}
      </div>
    </div>
  );
}

const NumberCard = ({ label, hint, value, onChange, min, max }) => (
  <div className="card p-3.5">
    <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
    <input
      type="number"
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value))}
      className="input mt-1"
      aria-label={label}
    />
    <div className="mt-1 text-[10px] text-slate-600">{hint}</div>
  </div>
);
