import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { Spinner } from './ui.jsx';

/**
 * THE CONTROL THAT COULD STOP THE LOOP AND HAD NO SCREEN.
 *
 * `canStartIteration()` refuses to begin a run once a hard budget is breached, and the engine
 * raises `budget stop: …` and notifies the operator — with a link to Governance. Governance had
 * panels for egress, audit, evidence, quality gates, licences, protected paths, secrets and
 * webhooks, and nothing at all about cost. So the one journey the notification promises ends on a
 * page that neither explains why the loop stopped nor offers a way to restart it.
 *
 * A route audit found seven server features in this state — built, reachable over HTTP, and with no
 * client anywhere in the dashboard. This is the one that can silently halt the product.
 *
 * The panel is read-first: what has been spent this period, what the forecast is, and only then the
 * caps. An operator arriving from that notification needs the explanation before the dial.
 */

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
};

export default function CostBudget({ toast }) {
  const res = useResource('governance-cost', () => api.costGovernance(), { interval: 0 });
  const { data, refetch } = res;
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);

  // `data?.state` is read field by field rather than trusted wholesale: assuming a nested API shape
  // has blanked a page in this dashboard more than once.
  const s = data?.state || {};
  const used = s.used || {};
  const budget = s.budget || {};
  const forecast = s.forecast || {};

  const edit = () =>
    setForm({
      period: budget.period || 'day',
      softCost: budget.softCost ?? '',
      hardCost: budget.hardCost ?? '',
      softTokens: budget.softTokens ?? '',
      hardTokens: budget.hardTokens ?? '',
    });

  const save = async () => {
    setBusy(true);
    try {
      const num = (v) => (v === '' || v == null ? null : Number(v));
      await api.setCostBudget({
        period: form.period,
        softCost: num(form.softCost),
        hardCost: num(form.hardCost),
        softTokens: num(form.softTokens),
        hardTokens: num(form.hardTokens),
      });
      toast?.('Budget saved', { type: 'success' });
      setForm(null);
      refetch();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Could not save the budget' });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="card p-3 text-[11px] text-slate-600">
        {res.error ? `Cost governance unavailable — ${res.error}` : 'Loading cost governance…'}
      </div>
    );
  }

  const hard = s.hardBreached;
  const soft = s.softBreached;

  return (
    <div className={`card p-3 ${hard ? 'border-rose-900/50 bg-rose-950/10' : soft ? 'border-amber-900/50 bg-amber-950/10' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Cost &amp; budget</h3>
        {hard && <span className="pill bg-rose-500/20 text-rose-300">iterations stopped</span>}
        {!hard && soft && <span className="pill bg-amber-500/20 text-amber-300">soft cap reached</span>}
        <div className="flex-1" />
        <span className="text-[10px] text-slate-600">per {budget.period || 'day'}</span>
        {!form && <button onClick={edit} className="btn-ghost">✎ set caps</button>}
      </div>

      <p className="mt-1 text-[11px] text-slate-500">
        {hard
          ? 'The hard cap for this period has been reached, so no new iteration will start. Raise it, or wait for the next period.'
          : soft
            ? 'The soft cap has been reached. Iterations continue; this is the warning before the hard cap.'
            : 'Iterations run while spending stays under the caps. A hard cap stops new runs; a resumed run is always allowed to finish.'}
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['spent', money(used.cost), budget.hardCost != null ? `cap ${money(budget.hardCost)}` : 'no cap'],
          ['tokens', compact(used.tokens), budget.hardTokens != null ? `cap ${compact(budget.hardTokens)}` : 'no cap'],
          ['forecast', money(forecast.cost), 'end of period'],
          ['unpriced', String(used.unpricedCalls ?? 0), 'calls with no rate'],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-lg bg-ink-800/40 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            <div className="font-mono text-[15px] text-white">{value}</div>
            <div className="text-[10px] text-slate-600">{sub}</div>
          </div>
        ))}
      </div>

      {form && (
        <div className="mt-3 border-t border-ink-800 pt-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[10px] text-slate-500">
              period
              <select
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
                className="input mt-0.5 block h-7 w-24 py-0 text-[11px]"
              >
                {['hour', 'day', 'week', 'month'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            {[
              ['softCost', 'soft $'],
              ['hardCost', 'hard $'],
              ['softTokens', 'soft tokens'],
              ['hardTokens', 'hard tokens'],
            ].map(([k, label]) => (
              <label key={k} className="text-[10px] text-slate-500">
                {label}
                <input
                  type="number"
                  min="0"
                  value={form[k]}
                  placeholder="none"
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  className="input mt-0.5 block h-7 w-24 py-0 text-[11px]"
                />
              </label>
            ))}
            <button onClick={save} disabled={busy} className="btn-primary h-7">{busy ? <Spinner /> : 'save'}</button>
            <button onClick={() => setForm(null)} className="btn-ghost h-7">cancel</button>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-600">Leave a field empty for “no cap”. Rates are per-model; unpriced calls are counted but not charged.</p>
        </div>
      )}

      {!!(data.breakdown?.byPurpose || []).length && (
        <div className="mt-2 border-t border-ink-800 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">where it went, this period</div>
          <div className="flex flex-wrap gap-1">
            {data.breakdown.byPurpose.slice(0, 8).map((b) => (
              <span key={b.key || b.purpose} className="pill bg-ink-800 text-slate-400">
                {b.key || b.purpose}: {compact(b.tokens)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
