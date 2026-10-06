import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { AreaChart, Kpi } from '../components/charts.jsx';
import { PageHeader, Spinner } from '../components/ui.jsx';

/**
 * ✨ Insight — the one screen that answers "is ISL actually helping?" (ISL_Frontend §15, P1).
 *
 * Every number here already existed; the problem was that answering that one question meant visiting
 * five pages and holding the result in your head. This is deliberately a **summary that routes**, not
 * a copy: each panel shows the headline figure and links to the view that owns the detail. Overview
 * answers a different question — "what is happening right now" — and is left alone.
 *
 * Two rules the panels follow, because a summary is exactly where dishonesty hides:
 *   - **A number ISL has not measured is shown as "not measured", never as zero.** Coverage with no
 *     run behind it, a cost with no configured rate, an agreement rate from three samples — each
 *     would read as a fact while being an absence.
 *   - **Every figure says where it came from.** "82% coverage" means nothing without "measured at
 *     commit abc123, two hours ago, suite green".
 */

const pct = (v) => (v == null ? null : `${v}%`);
const tone = (v, good, ok) => (v == null ? 'slate' : v >= good ? 'emerald' : v >= ok ? 'amber' : 'rose');

/** A figure ISL cannot currently measure — said plainly, with what would fix it. */
function NotMeasured({ what, how }) {
  return (
    <div className="text-[11px] text-slate-500">
      <span className="text-slate-400">{what} is not measured.</span> {how}
    </div>
  );
}

function Panel({ title, onOpen, openLabel, children, hint }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{title}</span>
        {hint && <span className="ml-2 text-[10px] text-slate-600">{hint}</span>}
        <div className="flex-1" />
        {onOpen && <button onClick={onOpen} className="btn-ghost text-[11px]">{openLabel || 'open'} →</button>}
      </div>
      <div className="space-y-2 px-3 py-3">{children}</div>
    </div>
  );
}

export default function Insight({ onNavigate }) {
  const { data: health } = useResource('insight:health', () => api.healthIndex(), { interval: 30000 });
  const { data: cov } = useResource('insight:coverage', () => api.coverage(), { interval: 0 });
  const { data: review } = useResource('insight:review', () => api.reviewQueue(), { interval: 15000 });
  const { data: deps } = useResource('insight:deps', () => api.dependencies(), { interval: 0 });
  const { data: cost } = useResource('insight:cost', () => api.governanceCost(), { interval: 30000 });

  if (!health) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const trend = (health.trend || []).map((t, i) => ({ t: i, score: t.score }));
  const measured = cov?.source === 'measured';
  const stats = review?.stats || {};
  const eff = cost?.efficiency;
  const state = cost?.state;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="✨ Insight"
        subtitle="Is ISL helping? One screen, from the signals it already measures — each panel links to the page that owns the detail."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Codebase health"
          value={health.score}
          sub={health.delta != null ? `${health.delta > 0 ? '+' : ''}${health.delta} since first snapshot` : 'no trend yet'}
          accent={tone(health.score, 70, 45)}
          icon="🩹"
        />
        <Kpi
          label="Lines covered"
          value={measured ? pct(cov.measured.totals.pct) : '—'}
          sub={measured ? `${cov.measured.totals.files} files measured` : 'never measured'}
          accent={measured ? tone(cov.measured.totals.pct, 60, 30) : 'slate'}
          icon="📐"
        />
        <Kpi
          label="Awaiting review"
          value={stats.pending ?? '—'}
          sub={`${stats.approved ?? 0} approved · ${stats.rejected ?? 0} rejected`}
          accent={stats.pending ? 'amber' : 'emerald'}
          icon="☑"
        />
        <Kpi
          label="Tokens / landed change"
          value={eff?.tokensPerLandedChange != null ? eff.tokensPerLandedChange.toLocaleString() : '—'}
          sub={eff?.landedChanges ? `${eff.landedChanges} landed this ${state?.period}` : 'nothing landed yet'}
          accent="teal"
          icon="⚡"
        />
      </div>

      <Panel
        title="Health trend"
        hint="the honest composite, snapshot by snapshot"
        onOpen={() => onNavigate?.('health')}
        openLabel="health"
      >
        {trend.length > 1 ? (
          <AreaChart data={trend} xKey="t" series={[{ key: 'score', accent: 'emerald', label: 'health' }]} height={110} />
        ) : (
          <NotMeasured what="A trend" how="It appears after a second health snapshot is taken." />
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          {Object.entries(health.components || {}).map(([k, v]) => (
            <span key={k}>{k}: <span className={v >= 70 ? 'text-emerald-400' : v >= 45 ? 'text-amber-400' : 'text-rose-400'}>{v}</span></span>
          ))}
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Test coverage"
          hint={measured ? 'measured' : 'static proxy'}
          onOpen={() => onNavigate?.('health')}
          openLabel="coverage"
        >
          {measured ? (
            <>
              <div className="text-[12px] text-slate-300">
                {cov.measured.totals.pct}% of lines · {cov.criticalCoverage}% of critical files
              </div>
              {/* Provenance, because a coverage number without it is a claim, not a measurement. */}
              <div className="text-[10px] text-slate-600">
                measured at {String(cov.measured.commit || '').slice(0, 7)}
                {cov.measured.dirty ? ` + ${cov.measured.uncommittedFiles} uncommitted file(s)` : ''} ·{' '}
                {new Date(cov.measured.measuredAt).toLocaleString()} ·{' '}
                {cov.measured.suiteGreen ? 'suite green' : <span className="text-amber-400">suite RED — these numbers are a floor</span>}
              </div>
            </>
          ) : (
            <NotMeasured
              what="Line coverage"
              how={`The static proxy reports ${cov?.criticalCoverage ?? '—'}% of critical files have a test importing them. Run a measurement on 🩹 Health for real per-line numbers.`}
            />
          )}
          {cov?.gaps?.length > 0 && (
            <div className="text-[11px] text-slate-500">
              worst gap: <code className="font-mono text-slate-400">{cov.gaps[0].file}</code>
              {cov.gaps[0].linePct != null ? ` — ${cov.gaps[0].linePct}% of lines` : ' — no test imports it'}
            </div>
          )}
        </Panel>

        <Panel
          title="Security posture"
          onOpen={() => onNavigate?.('security')}
          openLabel="security"
        >
          {deps?.total != null ? (
            <div className="text-[12px] text-slate-300">{deps.total} known vulnerability{deps.total === 1 ? '' : 'ies'} across dependencies</div>
          ) : (
            <NotMeasured what="Dependency vulnerabilities" how="Run a dependency scan on 🔒 Security." />
          )}
          <div className="text-[11px] text-slate-500">
            The deterministic gates veto secrets and weakened security on every diff, whatever a model scores it.
          </div>
        </Panel>
      </div>

      <Panel
        title="Cost & efficiency"
        hint="the sponsor's two questions"
        onOpen={() => onNavigate?.('governance')}
        openLabel="governance"
      >
        {state?.calls ? (
          <>
            <div className="text-[12px] text-slate-300">
              {state.calls.toLocaleString()} model call{state.calls === 1 ? '' : 's'} ·{' '}
              {state.tokens.toLocaleString()} tokens · {Math.round(state.ms / 60000)} min this {state.period}
            </div>
            {/* Money is only shown where a rate exists. A local model is free; an unpriced cloud
                model is UNKNOWN, and reporting €0 for it would be a measurement gap dressed as a fact. */}
            {state.unpricedCalls > 0 && (
              <div className="text-[11px] text-amber-300/80">
                {state.unpricedCalls} of {state.calls} call(s) went to a model with no configured rate — currency cost covers only the priced ones.
              </div>
            )}
            <div className="text-[11px] text-slate-500">
              {eff?.tokensPerLandedChange != null
                ? `${eff.tokensPerLandedChange.toLocaleString()} tokens per landed change`
                : 'No landed change this period — cost per change is not computable yet.'}
              {eff?.tokensPerHealthPoint != null && ` · ${eff.tokensPerHealthPoint.toLocaleString()} tokens per health point gained`}
            </div>
          </>
        ) : (
          <NotMeasured what="Model usage" how="It accumulates as the loop runs." />
        )}
      </Panel>
    </div>
  );
}
