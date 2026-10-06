import { Empty } from '../components/ui.jsx';
import { Sparkline } from '../components/charts.jsx';

/**
 * The workbench view answers the one question the test suite cannot: does the
 * application still RUN?
 *
 * Every iteration is booted in its sandbox before it is allowed to land — the
 * backend is started and health-checked, every service entrypoint is loaded, the
 * frontend is built. This is where you see whether the fleet is producing changes
 * that pass their tests and still break startup, and what the workbench agent had
 * to repair to stop them shipping.
 */

const CHECKS = {
  backend: { icon: '⚙', label: 'Backend boots and answers /api/health', weight: '55%' },
  services: { icon: '🔗', label: 'Every service entrypoint loads', weight: '25%' },
  frontend: { icon: '◨', label: 'Frontend builds', weight: '20%' },
};

export default function Workbench({ iteration, managers, events }) {
  const brief = (managers?.briefs || []).find((b) => b.name === 'Workbench');
  const recent = (iteration?.recent || []).filter((i) => i.scores?.workbench != null);
  const last = recent[0] || null;

  // Live boot detail from the event stream — the checks the last run actually did.
  const lastChecks = [...(events || [])]
    .reverse()
    .filter((e) => e.type === 'workbench.check')
    .slice(0, 6)
    .reduce((acc, e) => (acc[e.name] ? acc : { ...acc, [e.name]: e }), {});

  const fixes = (events || []).filter((e) => e.type === 'workbench.fix');
  const trend = recent.slice(0, 20).map((i) => i.scores.workbench).reverse();

  const stats = brief?.stats || {};
  const bootOk = stats.lastBootOk;

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto">
      {/* verdict */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="stat-label">Does the app run?</div>
            <div
              className={`stat mt-1 ${
                bootOk === true ? 'text-emerald-300' : bootOk === false ? 'text-rose-300' : 'text-slate-500'
              }`}
            >
              {bootOk === true ? 'YES' : bootOk === false ? 'NO' : '—'}
            </div>
          </div>
          <Metric label="Last boot score" value={stats.lastBootScore ?? '—'} />
          <Metric label="Avg boot health" value={stats.avgBootScore ?? '—'} />
          <Metric
            label="Boot failures"
            value={stats.bootFailures ?? 0}
            tone={stats.bootFailures ? 'text-rose-300' : 'text-slate-400'}
          />
          <Metric
            label="Auto-repaired"
            value={stats.autoHealed ?? 0}
            tone={stats.autoHealed ? 'text-amber-300' : 'text-slate-400'}
          />
          {trend.length > 2 && (
            <div className="ml-auto">
              <div className="stat-label mb-1">Boot health trend</div>
              <Sparkline data={trend} width={140} height={30} />
            </div>
          )}
        </div>

        {brief?.headline && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
              brief.status === 'alert'
                ? 'border-rose-900/50 bg-rose-950/30 text-rose-200'
                : brief.status === 'acting'
                  ? 'border-amber-900/50 bg-amber-950/30 text-amber-200'
                  : 'border-ink-700 bg-ink-800/40 text-slate-300'
            }`}
          >
            <span className="mr-1.5 font-semibold text-slate-400">Workbench manager:</span>
            {brief.headline}
          </div>
        )}
        {(brief?.recommendations || []).map((r, i) => (
          <div key={i} className="mt-1.5 flex gap-2 px-1 text-[11px] text-slate-400">
            <span className="text-brand">▸</span> {r}
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* the checks */}
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">The boot check</h3>
            <div className="flex-1" />
            <span className="text-[10px] text-slate-600">runs on every iteration, before it can land</span>
          </div>
          <div className="space-y-2 p-3">
            {Object.entries(CHECKS).map(([key, meta]) => {
              const c = lastChecks[key];
              const state = !c ? 'unknown' : c.skipped ? 'skipped' : c.ok ? 'ok' : 'fail';
              return (
                <div key={key} className="rounded-lg border border-ink-700/60 bg-ink-800/30 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{meta.icon}</span>
                    <span className="flex-1 text-[12px] text-slate-300">{meta.label}</span>
                    <span className="font-mono text-[10px] text-slate-600">{meta.weight}</span>
                    <span
                      className={`pill ${
                        state === 'ok'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : state === 'fail'
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-ink-700 text-slate-500'
                      }`}
                    >
                      {state}
                    </span>
                  </div>
                  {c?.detail && <p className="mt-1 pl-6 text-[11px] text-slate-500">{c.detail}</p>}
                  {c?.output && !c.ok && (
                    <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-ink-950/70 p-2 font-mono text-[10px] leading-relaxed text-rose-300/80">
                      {c.output.slice(-800)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* repairs */}
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Repairs by the workbench agent</h3>
          </div>
          <div className="p-3">
            {fixes.length ? (
              <ul className="space-y-1.5">
                {fixes.slice(-8).reverse().map((f, i) => (
                  <li key={i} className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="pill bg-amber-500/15 text-amber-300">repaired</span>
                      <span className="font-mono text-[11px] text-slate-300">{f.path}</span>
                    </div>
                    {f.summary && <p className="mt-1 text-[11px] text-slate-400">{f.summary}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                icon="🔧"
                title="Nothing has needed repairing"
                hint="When an iteration breaks startup, the workbench agent diagnoses it from the boot output, fixes the file, and boots again — up to twice — before the run is failed."
              />
            )}
          </div>
        </div>
      </div>

      {/* per-iteration boot record */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Boot verdict per iteration</h3>
        </div>
        {recent.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-ink-800">
                  <th className="px-3 py-2">Iteration</th>
                  <th className="px-3 py-2">Boot</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Files</th>
                  <th className="px-3 py-2">Plan</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 12).map((i) => (
                  <tr key={i.id} className="border-b border-ink-800/50">
                    <td className="px-3 py-1.5 font-mono text-slate-400">#{i.id}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`pill ${
                          i.scores.workbench === 100
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-rose-500/15 text-rose-300'
                        }`}
                      >
                        {i.scores.workbench === 100 ? 'boots' : `${i.scores.workbench}/100`}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-slate-400">{i.status}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-500">{i.filesChanged}</td>
                    <td className="max-w-md truncate px-3 py-1.5 text-slate-400">{i.planTitle || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-3">
            <Empty
              icon="🔧"
              title="No iteration has been booted yet"
              hint="Run an iteration: before it is allowed to commit, the app is started in the sandbox and health-checked."
            />
          </div>
        )}
      </div>
    </div>
  );
}

const Metric = ({ label, value, tone = 'text-slate-200' }) => (
  <div>
    <div className="stat-label">{label}</div>
    <div className={`stat mt-1 ${tone}`}>{value}</div>
  </div>
);
