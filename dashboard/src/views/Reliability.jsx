import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CardHead, Empty, Spinner, ago } from '../components/ui.jsx';

/**
 * The Reliability surface: how the fleet is failing and what to do about it.
 * Error clusters, anomalous runs, per-agent error counts, and the improvement
 * signals distilled from the patterns (deterministically, or on demand by the
 * LLM advisor).
 */
export default function Reliability({ managers, toast }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [commits, setCommits] = useState([]);
  const [bisect, setBisect] = useState(null);
  const [bisectBusy, setBisectBusy] = useState(false);
  const [revertingSha, setRevertingSha] = useState(null);
  const [flaky, setFlaky] = useState(null);

  const loadFlaky = async () => {
    try { setFlaky(await api.flaky()); } catch { /* non-fatal */ }
  };
  const setRetries = async (n) => {
    try { await api.setFlakyRetries(n); loadFlaky(); toast?.(`Flaky retry guard: ${n}`, { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  const load = async () => {
    try {
      setData(await api.reliability());
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    }
  };
  const loadRegression = async () => {
    try {
      const [c, b] = await Promise.all([api.regressionCommits(), api.bisectResult()]);
      setCommits(c.commits || []);
      setBisect(b.result || null);
      setBisectBusy(!!b.running);
    } catch { /* non-fatal */ }
  };
  useEffect(() => {
    load();
    loadRegression();
    loadFlaky();
  }, []);
  // Poll while a bisect is running (it runs the target's suite per step — can take minutes).
  useEffect(() => {
    if (!bisectBusy) return;
    const t = setInterval(loadRegression, 5000);
    return () => clearInterval(t);
  }, [bisectBusy]);

  const runBisect = async () => {
    setBisectBusy(true);
    try {
      await api.startBisect({});
      toast?.('Bisecting recent commits to find the regression…', { type: 'info' });
      setTimeout(loadRegression, 1500);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
      setBisectBusy(false);
    }
  };
  const doRevert = async (sha, title) => {
    if (!window.confirm(`Revert this commit on the work branch?\n\n${title}\n\nThis adds a revert commit; it does not rewrite history.`)) return;
    setRevertingSha(sha);
    try {
      const r = await api.revertCommit(sha);
      toast?.(`Reverted → ${r.sha?.slice(0, 8)}`, { type: 'success' });
      loadRegression();
    } catch (e) {
      toast?.(e.message || 'Revert failed (likely a conflict — needs a human)', { type: 'error' });
    } finally {
      setRevertingSha(null);
    }
  };

  const brief = (managers?.briefs || []).find((b) => b.name === 'Reliability');
  const health = brief?.stats?.health;

  const distill = async () => {
    setBusy(true);
    try {
      await api.reliabilityDistill();
      toast?.('Analysing error patterns…', { type: 'info' });
      setTimeout(load, 4000);
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const signalAction = async (id, action) => {
    try {
      const r = await api.reliabilitySignal(id, action);
      if (action === 'apply') toast?.(r?.applied ? `Applied: ${r.applied}` : 'Acknowledged', { type: 'success' });
      load();
    } catch (e) {
      toast?.(e.message, { type: 'error', title: 'Apply failed' });
    }
  };

  if (!data) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Reliability" value={health != null ? `${health}` : '—'} suffix="/100" tone={health >= 80 ? 'ok' : health >= 50 ? 'warn' : 'bad'} />
        <Stat label="Errors / 24h" value={data.errors24h} tone={data.errors24h ? 'warn' : 'ok'} />
        <Stat label="Open anomalies" value={data.anomalies.length} tone={data.anomalies.length ? 'bad' : 'ok'} />
        <Stat label="Open signals" value={data.signals.length} tone={data.signals.length ? 'warn' : 'ok'} />
      </div>

      {/* improvement signals */}
      <div className="card">
        <CardHead title="Improvement signals">
<button disabled={busy} onClick={distill} className="btn-ghost">{busy ? <Spinner /> : '✦'} Advisor</button>
        </CardHead>
        <div className="divide-y divide-ink-800">
          {data.signals.map((s) => {
            const applicable = s.applyTo && s.applyTo !== 'none' && s.patch;
            const patchStr = applicable ? Object.entries(s.patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : null;
            return (
              <div key={s.id} className="flex items-start gap-3 px-3 py-2.5">
                <span className="pill bg-ink-800 text-slate-400">{s.kind}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-slate-300">{s.recommendation}</div>
                  <div className="mt-0.5 text-[10px] text-slate-600">
                    {s.agentId ? `agent: ${s.agentId} · ` : ''}
                    {s.confidence != null ? `confidence ${s.confidence}% · ` : ''}
                    {applicable ? (
                      <span className="text-emerald-400/80">will apply → {s.applyTo}: {patchStr}</span>
                    ) : (
                      <span className="text-slate-600">needs manual investigation</span>
                    )}
                  </div>
                </div>
                {applicable ? (
                  <button onClick={() => signalAction(s.id, 'apply')} className="btn-primary shrink-0" title="Apply this fix to the fleet now">✓ apply fix</button>
                ) : (
                  <button onClick={() => signalAction(s.id, 'apply')} className="btn-ghost shrink-0" title="Acknowledge (no automatic change)">ack</button>
                )}
                <button onClick={() => signalAction(s.id, 'dismiss')} className="btn-ghost shrink-0" title="Dismiss">✕</button>
              </div>
            );
          })}
          {!data.signals.length && <Empty title="No improvement signals" hint="When agents fail in patterns, the recommendations to fix them appear here." />}
        </div>
      </div>

      {/* Regression bisect & revert — undo a bad commit the fleet made */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Regression bisect & revert</span>
          <div className="flex-1" />
          <button disabled={bisectBusy} onClick={runBisect} className="btn-ghost" title="Run the target's test suite across recent commits to find the one that introduced a break">
            {bisectBusy ? <Spinner /> : '🔎'} Find regression
          </button>
        </div>

        {bisect && (
          <div className={`mx-3 mt-3 rounded-lg border px-3 py-2 text-[12px] ${bisect.running ? 'border-sky-500/30 bg-sky-500/5' : bisect.culprit ? 'border-rose-500/30 bg-rose-500/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
            {bisect.running ? (
              <span className="text-sky-300">Bisecting… step {bisect.steps || 0}{bisect.current ? ` (checking ${bisect.current.sha})` : ''}</span>
            ) : bisect.error ? (
              <span className="text-rose-300">Bisect error: {bisect.error}</span>
            ) : bisect.culprit ? (
              <div className="flex items-center gap-2">
                <span className="text-rose-300">Culprit: <span className="font-mono">{bisect.culprit.shortSha}</span> (iter #{bisect.culprit.iterationId}) — {bisect.culprit.title}</span>
                <div className="flex-1" />
                <button disabled={revertingSha === bisect.culprit.sha} onClick={() => doRevert(bisect.culprit.sha, bisect.culprit.title)} className="btn-primary shrink-0">
                  {revertingSha === bisect.culprit.sha ? <Spinner /> : '↩'} Revert culprit
                </button>
              </div>
            ) : bisect.reason ? (
              <span className="text-amber-300">No culprit pinned — {bisect.reason}</span>
            ) : (
              <span className="text-emerald-300">No regression found across the last {bisect.checked?.length || 0} checked commit(s) — all verified good.</span>
            )}
          </div>
        )}

        <div className="mt-2 max-h-72 divide-y divide-ink-800 overflow-y-auto">
          {commits.map((c) => (
            <div key={c.sha} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className="font-mono text-[11px] text-slate-600">{c.shortSha}</span>
              <span className="pill bg-ink-800 text-slate-500">#{c.iterationId ?? '?'}</span>
              <span className="min-w-0 flex-1 truncate text-slate-300">{c.title.replace(/^\[ai-iter#\d+\]\s*/, '')}</span>
              <span className="text-[10px] text-slate-600">{ago(c.ts)}</span>
              <button disabled={revertingSha === c.sha} onClick={() => doRevert(c.sha, c.title)} className="btn-ghost shrink-0" title="Revert just this commit on the work branch">
                {revertingSha === c.sha ? <Spinner /> : '↩ revert'}
              </button>
            </div>
          ))}
          {!commits.length && <Empty title="No fleet commits" hint="Commits the fleet lands on the work branch appear here, each individually revertable." />}
        </div>
      </div>

      {/* Flaky-test detection & quarantine */}
      {flaky && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">Flaky tests</span>
            <span className="ml-2 text-[11px] text-slate-500">a suite that fails then passes on retry is a flake, not a regression — it won't reject a good change</span>
            <div className="flex-1" />
            <span className="mr-2 text-[11px] text-slate-500">retry guard</span>
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((n) => (
                <button key={n} onClick={() => setRetries(n)} className={`h-6 w-6 rounded-md text-[11px] ${flaky.retries === n ? 'bg-ink-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{n}</button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 px-3 py-3 sm:grid-cols-3">
            <div><div className="stat-label">Flakes caught (total)</div><div className="stat mt-0.5 text-white">{flaky.stats.total}</div></div>
            <div><div className="stat-label">This week</div><div className={`stat mt-0.5 ${flaky.stats.week ? 'text-amber-400' : 'text-slate-600'}`}>{flaky.stats.week}</div></div>
            <div><div className="stat-label">Retry guard</div><div className={`stat mt-0.5 ${flaky.retries ? 'text-emerald-400' : 'text-slate-600'}`}>{flaky.retries ? `${flaky.retries}×` : 'off'}</div></div>
          </div>
          {!!flaky.stats.topOffenders?.length && (
            <div className="border-t border-ink-800 px-3 py-2 text-[11px] text-slate-500">
              Top offenders: {flaky.stats.topOffenders.map((o) => `${o.project}/${o.suite} (${o.count})`).join(' · ')}
            </div>
          )}
          <div className="max-h-56 divide-y divide-ink-800 overflow-y-auto border-t border-ink-800">
            {flaky.events.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                <span className="pill bg-amber-500/15 text-amber-300">flake</span>
                <span className="min-w-0 flex-1 truncate text-slate-300">{e.project}/{e.suite} — passed after {e.attempts} retry(ies){e.iterationId ? ` · iter #${e.iterationId}` : ''}</span>
                <span className="text-[10px] text-slate-600">{ago(e.ts)}</span>
      </div>
            ))}
            {!flaky.events.length && <Empty icon="✓" title="No flakes recorded" hint="When a suite fails then passes on retry, it's logged here instead of blocking the change." />}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* error clusters */}
        <div className="card">
          <CardHead title="Error clusters" />
          <div className="max-h-80 divide-y divide-ink-800 overflow-y-auto">
            {data.clusters.map((c, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="pill bg-rose-500/15 text-rose-300">{c.count}×</span>
                  <span className="pill bg-ink-800 text-slate-400">{c.category}</span>
                  <span className="ml-auto text-[10px] text-slate-600">{ago(c.lastTs)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] text-slate-400">{c.sample}</div>
                {c.agents.length > 0 && <div className="mt-0.5 text-[10px] text-slate-600">agents: {c.agents.join(', ')}</div>}
              </div>
            ))}
            {!data.clusters.length && <Empty title="No errors" hint="Nothing has failed recently." />}
          </div>
        </div>

        {/* anomalies */}
        <div className="card">
          <CardHead title="Anomalies" />
          <div className="max-h-80 divide-y divide-ink-800 overflow-y-auto">
            {data.anomalies.map((a) => (
              <div key={a.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`pill ${a.severity === 'critical' ? 'bg-rose-600/25 text-rose-200' : 'bg-amber-500/15 text-amber-300'}`}>{a.kind}</span>
                  <span className="ml-auto text-[10px] text-slate-600">{ago(a.ts)}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">{a.message}</div>
              </div>
            ))}
            {!data.anomalies.length && <Empty title="No anomalies" hint="No strange agent behaviour detected." />}
          </div>
        </div>
      </div>

      {/* errors by agent */}
      {data.byAgent.length > 0 && (
        <div className="card">
          <CardHead title="Errors by agent (24h)" />
          <div className="flex flex-wrap gap-2 p-3">
            {data.byAgent.map((a) => (
              <span key={a.agent} className="pill bg-ink-800 text-slate-300">{a.agent} · {a.count}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const Stat = ({ label, value, suffix, tone }) => (
  <div className="card p-3">
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone === 'bad' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-emerald-400'}`}>
      {value}<span className="text-sm text-slate-600">{suffix}</span>
    </div>
  </div>
);
