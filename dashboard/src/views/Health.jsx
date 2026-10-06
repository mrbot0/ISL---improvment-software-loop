import { useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { CardHead, Empty, PageHeader, Spinner } from '../components/ui.jsx';

/**
 * Codebase Health — the honest answer to "is ISL actually improving this codebase?". A single
 * composite score (0-100) with its components and a trend line, plus the structural refactor
 * candidates (god-files, over-complex files) the fleet can be pointed at. The score climbs as
 * god-files are split and tests are added.
 */
const COMP_LABEL = {
  structure: 'Structure (god-files)',
  complexity: 'Complexity',
  testRatio: 'Test coverage (proxy)',
  sizeSpread: 'Size spread',
};
const bar = (v) => (v >= 70 ? 'bg-emerald-500' : v >= 45 ? 'bg-amber-500' : 'bg-rose-500');
const ring = (v) => (v >= 70 ? 'text-emerald-400' : v >= 45 ? 'text-amber-400' : 'text-rose-400');
// Blast-radius pill: how many modules import this file (⟿ = "reaches"). High = refactor carefully.
const BLAST = {
  high: 'bg-rose-500/15 text-rose-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-slate-600/20 text-slate-400',
};

export default function Health({ toast }) {
  /*
   * `health-index`, NOT `health`.
   *
   * `HealthWidget` in the top bar is always mounted and caches `/api/health` — the server's
   * liveness, `{ok, ollama, repo}` — under the key `health`. This view wanted `/api/health-index`,
   * the codebase score, and shared the key. The widget won the race, this view read its payload,
   * `if (!health)` passed because the object is perfectly truthy, and `Object.entries(undefined)`
   * took the page down with "Cannot convert undefined or null to object".
   *
   * Two different shapes behind one cache key is the same defect as the `deployments` collision
   * fixed earlier: the key is the contract, and nothing enforces it.
   */
  const { data: health } = useResource('health-index', () => api.healthIndex(), { interval: 30000 });
  const { data: struct, refetch: reloadStruct } = useResource('structural', () => api.structural(), { interval: 0 });
  const { data: cov, refetch: reloadCov } = useResource('coverage', () => api.coverage(), { interval: 0 });
  const { data: impact } = useResource('impact', () => api.impact(), { interval: 0 });
  // A coverage run takes minutes, so this one polls: while `running` is true the number on screen
  // is the previous measurement, and it is labelled as such rather than blanked out.
  const { data: measured, refetch: reloadMeasured } = useResource('coverage-measured', () => api.measuredCoverage(), { interval: 15000 });
  const [seeding, setSeeding] = useState(false);
  const [seedingCov, setSeedingCov] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [preview, setPreview] = useState(null); // { file, loading, plan }

  const showPreview = async (file) => {
    if (preview?.file === file) return setPreview(null); // toggle off
    setPreview({ file, loading: true });
    try {
      const plan = await api.refactorPlan(file);
      setPreview({ file, plan });
    } catch (e) {
      toast?.(e.message, { type: 'error' });
      setPreview(null);
    }
  };

  if (!health) return <div className="grid h-40 place-items-center text-slate-500"><Spinner /></div>;

  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api.seedStructural(5);
      toast?.(`Seeded ${r.added} structural refactor task(s) into the backlog`, { type: 'success' });
      reloadStruct();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setSeeding(false);
    }
  };

  const seedCov = async () => {
    setSeedingCov(true);
    try {
      const r = await api.seedCoverage(5);
      toast?.(`Seeded ${r.added} characterization-test task(s) into the backlog`, { type: 'success' });
      reloadCov();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setSeedingCov(false);
    }
  };

  const measure = async () => {
    setMeasuring(true);
    try {
      const r = await api.measureCoverage();
      toast?.(
        r.started
          ? 'Coverage run started — it runs the whole suite in a sandbox and can take several minutes.'
          : r.reason || 'A coverage run is already in progress.',
        { type: r.started ? 'success' : 'info' },
      );
      reloadMeasured();
    } catch (e) {
      toast?.(e.message, { type: 'error' });
    } finally {
      setMeasuring(false);
    }
  };

  const running = !!measured?.running;
  const last = measured?.last;
  const trend = health.trend || [];
  const min = Math.min(...trend.map((t) => t.score), health.score, 0);
  const max = Math.max(...trend.map((t) => t.score), health.score, 100);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="🩹 Codebase Health" subtitle="A deterministic composite score, tracked over time — the honest measure of whether ISL is improving this codebase." />

      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        {/* Score */}
        <div className="card flex flex-col items-center justify-center p-4">
          <div className={`font-display text-5xl leading-none ${ring(health.score)}`}>{health.score}</div>
          <div className="stat-label mt-1">/ 100 health</div>
          {health.delta != null && (
            <div className={`mt-2 text-[12px] ${health.delta > 0 ? 'text-emerald-400' : health.delta < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
              {health.delta > 0 ? '▲' : health.delta < 0 ? '▼' : '='} {health.delta > 0 ? '+' : ''}{health.delta} since first snapshot
            </div>
          )}
        </div>
        {/* Components */}
        <div className="card space-y-2.5 p-4">
          {Object.entries(health.components).map(([k, v]) => (
            <div key={k}>
              <div className="flex justify-between text-[11px]"><span className="text-slate-400">{COMP_LABEL[k] || k}</span><span className={ring(v)}>{v}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800"><div className={`h-full ${bar(v)}`} style={{ width: `${v}%` }} /></div>
            </div>
          ))}
          <div className="pt-1 text-[10px] text-slate-600">
            {health.facts.sourceFiles} source · {health.facts.testFiles} test files · {health.facts.godFiles} god-files · avg complexity {health.facts.avgComplexity}
          </div>
        </div>
      </div>

      {/* Trend */}
      {trend.length > 1 && (
        <div className="card p-3">
          <div className="card-title mb-2">Health trend ({trend.length} snapshots)</div>
          <svg viewBox={`0 0 ${trend.length * 10} 60`} preserveAspectRatio="none" className="h-16 w-full">
            <polyline
              fill="none" stroke="currentColor" strokeWidth="1.5" className={ring(health.score)}
              points={trend.map((t, i) => `${i * 10},${60 - ((t.score - min) / (max - min || 1)) * 56 - 2}`).join(' ')}
            />
          </svg>
        </div>
      )}

      {/* Structural refactor candidates */}
      <div className="card">
        <div className="card-head">
        <span className="card-title">Structural refactor candidates{struct ? ` (${struct.candidates.length})` : ''}</span>
<button onClick={seed} disabled={seeding} className="btn-primary" title="Add the top 5 as behaviour-preserving refactor tasks">
            {seeding ? <Spinner /> : '＋'} Seed top 5 to backlog
          </button>
        </div>
        <div className="max-h-[45vh] divide-y divide-ink-800 overflow-y-auto">
          {(struct?.candidates || []).map((c, i) => (
            <div key={i}>
              <div className="flex items-center gap-3 px-3 py-2 text-[12px]">
                <span className="pill bg-ink-800 text-slate-400">{c.recipe}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{c.file}</span>
                {c.blast && (
                  <span
                    className={`pill ${BLAST[c.blast.risk] || BLAST.low}`}
                    title={`${c.blast.dependentCount} module(s) import this${c.blast.testCount ? `, ${c.blast.testCount} test(s) cover it` : ', no tests'}${c.blast.sensitive ? ' — sensitive area' : ''}. ${c.blast.risk === 'high' ? 'Wide blast radius: refactor with care / human review.' : ''}`}
                  >
                    ⟿ {c.blast.dependentCount}
                  </span>
                )}
                <span className="text-slate-500">{c.lines}L · ~{c.complexity} br</span>
                <button onClick={() => showPreview(c.file)} className="btn-ghost text-[11px]" title="Dry-run: preview how this file would split before any change">
                  {preview?.file === c.file ? '▲ hide' : '⧉ preview'}
                </button>
              </div>
              {preview?.file === c.file && (
                <div className="border-t border-ink-800 bg-ink-900/40 px-3 py-2">
                  {preview.loading ? <div className="grid h-16 place-items-center"><Spinner /></div> : <RefactorPreview plan={preview.plan} />}
                </div>
              )}
            </div>
          ))}
          {struct && !struct.candidates.length && <Empty icon="✓" title="No structural smells" hint="No god-files or over-complex files detected." />}
          {!struct && <div className="grid h-24 place-items-center"><Spinner /></div>}
        </div>
      </div>

      {/* Coverage gaps — critical files with no tests, or too few of their lines exercised */}
      <div className="card">
        <div className="card-head flex-wrap gap-y-1">
          <span className="card-title">
            Coverage gaps{cov ? ` — critical coverage ${cov.criticalCoverage}%` : ''}
          </span>
          {cov && (
            <span className="ml-2 text-[11px] text-slate-500">{cov.coveredCritical}/{cov.totalCritical} critical files covered</span>
          )}
          {/* Never let a static proxy be mistaken for a measurement. */}
          {cov && (
            <span
              className={`pill ml-2 ${cov.source === 'measured' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-600/20 text-slate-400'}`}
              title={cov.source === 'measured'
                ? `Measured by running the suite at ${cov.measured?.commit?.slice(0, 7)}${cov.measured?.dirty ? ` + ${cov.measured.uncommittedFiles} uncommitted file(s)` : ''} on ${new Date(cov.measured?.measuredAt).toLocaleString()}`
                : 'Static proxy: a file counts as covered when any test file imports it. Run a measurement for real per-line numbers.'}
            >
              {cov.source === 'measured' ? 'measured' : 'static proxy'}
            </span>
          )}
          {cov?.source === 'measured' && cov.measured?.totals && (
            <span className="ml-2 text-[11px] text-slate-500">{cov.measured.totals.pct}% of lines repo-wide</span>
          )}
          {cov?.source === 'measured' && cov.measured?.suiteGreen === false && (
            <span className="pill ml-2 bg-amber-500/15 text-amber-300" title="Some tests failed during the run, so these numbers are a floor, not the truth.">suite red</span>
          )}
          <div className="flex-1" />
          <button
            onClick={measure}
            disabled={measuring || running}
            className="btn"
            title="Run the target's own test suite with coverage, in a sandbox at HEAD. Takes minutes; never touches your working tree."
          >
            {measuring || running ? <Spinner /> : '📐'} {running ? 'Measuring…' : 'Measure coverage'}
          </button>
          <button onClick={seedCov} disabled={seedingCov} className="btn-primary" title="Add the top 5 coverage gaps as test tasks">
            {seedingCov ? <Spinner /> : '＋'} Seed top 5 tests
          </button>
        </div>
        {/* When a run could not produce numbers, say exactly why — and how to unblock it. */}
        {last && !last.available && !running && (
          <div className="border-b border-ink-800 px-3 py-2 text-[11px] text-amber-300/90">
            No measured coverage: {last.reason}
            {last.blockers?.length > 1 && (
              <span className="text-slate-500"> · also blocked in: {last.blockers.slice(1).map((b) => b.dir).join(', ')}</span>
            )}
          </div>
        )}
        <div className="max-h-[45vh] divide-y divide-ink-800 overflow-y-auto">
          {(cov?.gaps || []).map((g, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className={`pill ${g.criticality >= 80 ? BLAST.high : g.criticality >= 50 ? BLAST.medium : BLAST.low}`} title="Criticality (blast radius + routes + sensitivity)">crit {g.criticality}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{g.file}</span>
              {g.sensitive && <span className="pill bg-rose-500/15 text-rose-300">sensitive</span>}
              {/* linePct null = never measured, which is NOT the same as measured at 0%. */}
              {g.linePct != null ? (
                <span
                  className={`pill ${g.linePct >= 50 ? 'bg-emerald-500/15 text-emerald-300' : g.linePct >= 20 ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300'}`}
                  title={`${g.coveredLines}/${g.measuredLines} lines executed by the suite`}
                >
                  {g.linePct}% lines
                </span>
              ) : (
                <span className="pill bg-slate-600/20 text-slate-400" title="No test file imports this one">no tests</span>
              )}
              <span className="text-slate-500" title="modules that depend on this file">{g.dependents} dep{g.routes ? ` · ${g.routes} routes` : ''}</span>
      </div>
          ))}
          {cov && !cov.gaps.length && <Empty icon="✓" title="No critical coverage gaps" hint="Every critical file is covered." />}
          {!cov && <div className="grid h-24 place-items-center"><Spinner /></div>}
        </div>
      </div>

      {/* Highest-leverage files — unified impact ranking */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Highest-leverage files</span>
          <span className="ml-2 text-[11px] text-slate-500">composite: reach × untested × routes × sensitivity × size</span>
        </div>
        <div className="max-h-[45vh] divide-y divide-ink-800 overflow-y-auto">
          {(impact?.top || []).slice(0, 20).map((r, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 text-[12px]">
              <span className={`pill ${r.score >= 70 ? BLAST.high : r.score >= 45 ? BLAST.medium : BLAST.low}`}>{r.score}</span>
              <span className="pill bg-ink-800 text-slate-400">{r.action}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{r.file}</span>
              <span className="hidden text-[10px] text-slate-600 sm:block">{r.reasons.join(' · ')}</span>
            </div>
          ))}
          {!impact && <div className="grid h-24 place-items-center"><Spinner /></div>}
        </div>
      </div>
    </div>
  );
}

const ROLE = {
  section: 'text-sky-300', dialog: 'text-violet-300', component: 'text-emerald-300',
  hook: 'text-amber-300', helper: 'text-slate-400', constant: 'text-slate-500', value: 'text-slate-500',
};

/** Deterministic dry-run preview of a god-file split — no change is made. */
function RefactorPreview({ plan }) {
  if (!plan || plan.error) return <div className="text-[12px] text-rose-300">{plan?.error || 'No plan.'}</div>;
  return (
    <div className="space-y-2 text-[12px]">
      <div className="text-slate-300">{plan.summary}</div>
      <div className="text-[11px] text-slate-500">
        Dry run — nothing is changed. {plan.entry ? <><span className="text-slate-400">{plan.entry.name}</span> stays as the entry. </> : null}
        {plan.rewires?.length
          ? <span className="text-amber-400">{plan.rewires.length} call-site(s) use named exports and would rewire.</span>
          : <span className="text-emerald-400">Only the default export is imported — nothing external rewires.</span>}
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {(plan.groups || []).map((g, i) => (
          <div key={i} className="rounded-lg border border-ink-800 bg-ink-950/40 p-2">
            <div className="flex items-center justify-between">
              <span className="truncate font-mono text-[11px] text-slate-300">{g.target.split('/').slice(-2).join('/')}</span>
              <span className="text-[10px] text-slate-600">{g.lines}L</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
              {g.symbols.slice(0, 10).map((s) => (
                <span key={s.name} className={ROLE[s.role] || 'text-slate-400'} title={`${s.role} · ${s.lines} lines`}>{s.name}</span>
              ))}
              {g.symbols.length > 10 && <span className="text-slate-600">+{g.symbols.length - 10}</span>}
            </div>
          </div>
        ))}
      </div>
      {!!(plan.rewires || []).length && (
        <div className="text-[10px] text-slate-500">
          Rewires: {plan.rewires.slice(0, 4).map((r) => `${r.file.split('/').pop()} (${r.symbols.join(', ')})`).join(' · ')}
        </div>
      )}
    </div>
  );
}
