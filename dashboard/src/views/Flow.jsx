import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useResource } from '../hooks.js';
import { SAFETY_NET_LIVE_MS } from '../liveKeys.js';
import { AGENT_META, Spinner, ago } from '../components/ui.jsx';
import { accentHex } from '../components/charts.jsx';
import { GatePills } from '../components/GateRecord.jsx';

/**
 * The Flow view: what the fleet is doing RIGHT NOW, and how it is getting on.
 *
 * The previous version answered "what happened" and only barely: a reverse-chronological event log
 * beside a rail that said `iteration in progress` and nothing else. During a run — which is the only
 * time anyone opens this page — it could not say which run, what it was trying to do, which step it
 * was on, or how long any of it had taken. Idle, it showed an empty log and the word "idle", so the
 * page carried no information for the majority of the time it was on screen.
 *
 * What it shows now is built from data the client already has: the store's incrementally-tracked
 * `activeRun`, the phase events on the bus, and the run list in the state snapshot. No new endpoint,
 * no polling.
 */

/** Pipeline order — must match the engine's PHASES (src/iteration/engine.js). */
const PHASES = ['catalog', 'survey', 'plan', 'implement', 'review', 'security', 'regression', 'test', 'workbench', 'finalize'];

/** What each phase is actually doing, in the words an operator would use. */
const PHASE_BLURB = {
  catalog: 'indexing the codebase',
  survey: 'reading the code to decide what is worth changing',
  plan: 'turning findings into a batch of tasks',
  implement: 'the specialists are editing files in the sandbox',
  review: 'grading the diff and checking it compiles',
  security: 'scanning the diff for secrets and weakened controls',
  regression: 'checking nothing public was removed',
  test: "running the project's own suite",
  workbench: 'does the app still boot and serve?',
  finalize: 'committing, or rolling back',
};

/** Wall-clock time for a log line. An unusable timestamp shows nothing rather than "Invalid Date". */
const clock = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toLocaleTimeString(undefined, { hour12: false });
};

const secs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/*
 * Whole class strings, not `bg-${tint}-500/15`.
 *
 * Tailwind extracts class names by scanning the source text, so a class assembled at runtime is
 * never generated and the element renders unstyled — a failure that looks like a design mistake
 * rather than a build one, and that no test catches unless it asserts computed colour.
 */
const STATUS_STYLE = {
  committed: 'bg-emerald-500/15 text-emerald-300',
  promoted: 'bg-emerald-500/15 text-emerald-300',
  scored: 'bg-sky-500/15 text-sky-300',
  running: 'bg-sky-500/15 text-sky-300',
  rolled_back: 'bg-fuchsia-500/15 text-fuchsia-300',
  rejected: 'bg-amber-500/15 text-amber-300',
  error: 'bg-rose-500/15 text-rose-300',
  interrupted: 'bg-amber-500/15 text-amber-300',
  empty: 'bg-slate-500/15 text-slate-300',
};

/**
 * Per-phase timings for one run, derived from the event log.
 *
 * A `running` event opens a phase and the matching terminal event closes it, so the log yields real
 * durations without the server having to send any. The log is a bounded tail and can therefore be
 * missing the start of a long run — a phase whose opening event was evicted is simply absent rather
 * than shown with a wrong duration, because a fabricated "0s" would be read as a fact.
 */
export function phaseTimings(events, runId) {
  if (runId == null) return [];
  const open = new Map();
  const done = new Map();
  for (const e of events) {
    if (e.type !== 'iteration.phase' || e.iterationId !== runId) continue;
    if (e.status === 'running') open.set(e.phase, e.ts);
    else if (open.has(e.phase)) {
      done.set(e.phase, { ms: e.ts - open.get(e.phase), status: e.status, summary: e.summary, score: e.score });
      open.delete(e.phase);
    } else {
      done.set(e.phase, { ms: null, status: e.status, summary: e.summary, score: e.score });
    }
  }
  return PHASES.map((p) => ({
    phase: p,
    ...(done.get(p) || (open.has(p) ? { ms: null, status: 'running', startedAt: open.get(p) } : null) || {}),
    live: open.has(p),
    startedAt: open.get(p) ?? null,
  })).filter((p) => p.status || p.live);
}

/**
 * Stored history + what has arrived on the socket since, as one list.
 *
 * Durable events carry the same `id` in both, because `emit` writes the row and puts its id on the
 * broadcast — so identity is exact for those. The rest are matched on what makes them unique, which
 * is enough: the alternative to a composite key is the same tool call appearing twice.
 */
export function mergeFlowEvents(stored = [], live = []) {
  const seen = new Set();
  const out = [];
  // A default parameter only fills in for `undefined`, and a resource that has not loaded yet holds
  // `null` — the one value that would have thrown here.
  for (const e of [...(stored || []), ...(live || [])]) {
    if (!e) continue;
    const key = e.id != null ? `id:${e.id}` : `${e.type}|${e.ts}|${e.iterationId ?? ''}|${e.tool ?? ''}|${e.path ?? ''}|${e.index ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export default function Flow({ events, orchestrator, iteration, activeRun }) {
  const [, tick] = useState(0);

  /*
   * The live prop is 60 seeded events plus whatever the socket has delivered to THIS tab. That is
   * why the panel looked empty on arrival and forgot everything on reload: it was never reading a
   * history, only watching one go by. This fetches the stored one and merges the two.
   */
  const history = useResource('events', () => api.events(400), { interval: SAFETY_NET_LIVE_MS });
  const merged = mergeFlowEvents(history.data || [], events || []);

  const controllerRunning = !!iteration?.controller?.running;
  const run = activeRun || (controllerRunning ? { id: iteration?.controller?.current ?? null, phase: null, startedAt: null, phaseAt: null } : null);
  const running = !!run;

  // Elapsed times are only worth re-rendering while something is actually elapsing.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const recent = iteration?.recent || [];
  // The run list carries the plan title and the gate verdicts; the event stream carries the phase.
  // Neither alone says what this run is doing, which is why the old rail could not.
  const meta = run?.id != null ? recent.find((r) => r.id === run.id) : null;
  const last = recent.find((r) => r.status !== 'running') || null;
  const timings = phaseTimings(merged, run?.id ?? last?.id ?? null);

  const agent = orchestrator?.current?.agentId;
  // Coalesced in chronological order, THEN reversed — folding after the reverse would group the
  // wrong neighbours and show the oldest member's timestamp as the group's.
  const steps = coalesce(merged.map((e) => ({ e, s: STAGE(e) })).filter((x) => x.s)).slice(-300).reverse();

  return (
    <div className="grid h-full gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="min-h-0 space-y-3 overflow-auto">
        {running ? (
          <NowRunning run={run} meta={meta} />
        ) : agent ? (
          <div className="card p-4">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Now running</h3>
            <div className="flex items-center gap-2">
              <span className="text-lg">{AGENT_META[agent]?.emoji}</span>
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-white"><Spinner className="text-emerald-400" /> {agent}</div>
                <div className="text-[10px] text-slate-500">proposal agent</div>
              </div>
            </div>
          </div>
        ) : (
          // Idle is the common case, and "idle" on its own is the least useful thing this page
          // could say. What just happened is what an operator wants when nothing is happening.
          <LastRun run={last} armed={orchestrator?.looping} />
        )}

        <div className="card p-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Review queue</h3>
          {orchestrator?.fleet?.queued?.length ? (
            <ul className="space-y-1">
              {orchestrator.fleet.queued.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-[12px] text-slate-300">
                  <span className="text-slate-600">{i + 1}.</span> {AGENT_META[a]?.emoji} {a}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-slate-600">nothing queued</div>
          )}
        </div>

        <div className="card p-3 text-[11px] text-slate-500">
          <div className="flex justify-between"><span>pending review</span><span className="font-mono text-slate-300">{orchestrator?.fleet?.pending ?? 0}</span></div>
          <div className="mt-1 flex justify-between">
            <span>pipeline</span>
            <span className={orchestrator?.looping ? 'text-emerald-400' : 'text-slate-500'}>
              {orchestrator?.running ? 'iterating' : orchestrator?.looping ? 'armed' : 'stopped'}
            </span>
          </div>
          <div className="mt-1 flex justify-between"><span>parallel</span><span className="font-mono text-slate-300">{orchestrator?.parallel?.maxTasks ?? 1}×</span></div>
        </div>
      </div>

      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
        <PhaseBreakdown timings={timings} runId={run?.id ?? last?.id} live={running} />

        <div className="card flex min-h-0 flex-col">
          <h3 className="border-b border-ink-800 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Live flow</h3>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!steps.length ? (
              <div className="grid h-full place-items-center text-xs text-slate-600">Nothing happening yet. Start a loop or run an agent.</div>
            ) : (
              <ol className="relative space-y-3 border-l border-ink-700 pl-5">
                {steps.map(({ e, s, count }, i) => (
                  <li key={e.id ?? `${e.ts}-${i}`} className="relative">
                    <span
                      className="absolute -left-[26px] grid h-4 w-4 place-items-center rounded-full text-[10px]"
                      style={{ background: accentHex(s.tint) + '22', color: accentHex(s.tint) }}
                    >
                      {s.icon}
                    </span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] text-slate-200">{s.text}</span>
                      {count > 1 && (
                        <span className="pill bg-ink-800 text-slate-500" title={`${count} of these in a row`}>×{count}</span>
                      )}
                      {/* Clock time, not "just now". During a run most entries are seconds apart, so
                          a relative label reads identically on every line and orders nothing. */}
                      <time className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-slate-600" title={ago(e.ts)}>
                        {clock(e.ts)}
                      </time>
                    </div>
                    {s.sub && <div className="truncate text-[10px] text-slate-500" title={s.sub}>{s.sub}</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The run in flight: which one, what it is trying to do, where it has got to, and for how long. */
function NowRunning({ run, meta }) {
  const idx = run?.phase ? PHASES.indexOf(run.phase) : -1;
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Now running</h3>
        <span className="ml-auto font-mono text-[11px] text-slate-500">{run.id != null ? `#${run.id}` : ''}</span>
      </div>

      {/* The plan title is the answer to "what is it doing?" — the phase only says how. */}
      <div className="text-[13px] font-medium leading-snug text-slate-100">
        {meta?.planTitle || 'planning the batch…'}
      </div>
      {run.trigger && <div className="mt-0.5 text-[10px] text-slate-600">triggered by {run.trigger}</div>}

      <div className="mt-3 flex items-center gap-0.5">
        {PHASES.map((p, i) => (
          <span
            key={p}
            title={`${p} — ${PHASE_BLURB[p]}`}
            className={`h-1.5 flex-1 rounded-sm ${idx < 0 ? 'bg-ink-700' : i < idx ? 'bg-emerald-600/70' : i === idx ? 'bg-emerald-400' : 'bg-ink-700'}`}
          />
        ))}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-emerald-300">{run.phase || 'starting'}</span>
        <span className="text-[10px] text-slate-500">{idx >= 0 ? `step ${idx + 1} of ${PHASES.length}` : ''}</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-400" title="time in this phase">
          {run.phaseAt ? secs(Date.now() - run.phaseAt) : '—'}
        </span>
      </div>
      {run.phase && <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{PHASE_BLURB[run.phase]}</div>}
      {run.summary && <div className="mt-1 text-[11px] leading-snug text-slate-400">{run.summary}</div>}

      <div className="mt-3 flex justify-between border-t border-ink-800 pt-2 text-[10px] text-slate-600">
        <span>total</span>
        <span className="font-mono tabular-nums text-slate-400">{run.startedAt ? secs(Date.now() - run.startedAt) : '—'}</span>
      </div>
    </div>
  );
}

/** Nothing is running — so say what the last run did, and whether another is coming. */
function LastRun({ run, armed }) {
  return (
    <div className="card p-4">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Idle — last run</h3>
      {!run ? (
        <div className="text-xs text-slate-600">No runs yet.</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className={`pill ${STATUS_STYLE[run.status] || 'bg-ink-800 text-slate-400'}`}>
              {String(run.status).replace('_', ' ')}
            </span>
            <span className="font-mono text-[11px] text-slate-500">#{run.id}</span>
            {run.scores?.total != null && (
              <span className="ml-auto font-mono text-[12px] font-bold" style={{ color: accentHex(run.scores.total >= 80 ? 'emerald' : run.scores.total >= 60 ? 'amber' : 'rose') }}>
                {run.scores.total}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[12px] leading-snug text-slate-200">{run.planTitle || 'Untitled run'}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <GatePills gates={run.gates} />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-600">
            <span>{ago(run.finishedAt || run.startedAt)}</span>
            <span>{run.filesChanged || 0} file(s)</span>
          </div>
        </>
      )}
      <div className="mt-3 border-t border-ink-800 pt-2 text-[10px]">
        {armed
          ? <span className="text-emerald-400">the loop is armed — another run will start on its own</span>
          : <span className="text-slate-500">the loop is stopped — nothing will start until you say so</span>}
      </div>
    </div>
  );
}

/**
 * Where the time actually went.
 *
 * The single most common operational question during a long run is "is it stuck, or is this step
 * just slow?", and it is unanswerable from a list of events with relative timestamps. Per-phase
 * durations answer it directly, and they keep answering it after the run ends, when "why did that
 * take eleven minutes?" is the question.
 */
function PhaseBreakdown({ timings, runId, live }) {
  if (!timings.length) {
    return (
      <div className="card px-4 py-3 text-[11px] text-slate-600">
        No phase activity in the current event window
        {runId != null ? ` for run #${runId}` : ''}. Phases appear here as a run progresses.
      </div>
    );
  }
  const known = timings.filter((t) => t.ms != null);
  const longest = Math.max(1, ...known.map((t) => t.ms));
  const total = known.reduce((a, t) => a + t.ms, 0);

  return (
    <div className="card">
      <div className="flex items-baseline gap-2 border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {live ? 'This run, phase by phase' : 'Last run, phase by phase'}
        </h3>
        {runId != null && <span className="font-mono text-[11px] text-slate-600">#{runId}</span>}
        {total > 0 && <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-500">{secs(total)} measured</span>}
      </div>
      <ul className="divide-y divide-ink-800/60">
        {timings.map((t) => (
          <li key={t.phase} className="flex items-center gap-2 px-4 py-1.5">
            <span className={`w-4 shrink-0 text-center text-[11px] ${
              t.status === 'error' ? 'text-rose-400' : t.live ? 'text-emerald-400' : t.status === 'skipped' ? 'text-slate-600' : 'text-emerald-600'
            }`}>
              {t.status === 'error' ? '✕' : t.live ? '⟳' : t.status === 'skipped' ? '·' : '✓'}
            </span>
            <span className={`w-20 shrink-0 text-[11px] ${t.live ? 'font-medium text-emerald-300' : 'text-slate-300'}`}>{t.phase}</span>

            {/* Relative bar: which step dominated, readable without comparing numbers. */}
            <span className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-sm bg-ink-800 sm:block">
              {t.ms != null && (
                <span
                  className={`block h-full rounded-sm ${t.status === 'error' ? 'bg-rose-500/70' : 'bg-sky-500/60'}`}
                  style={{ width: `${Math.max(2, (t.ms / longest) * 100)}%` }}
                />
              )}
            </span>

            {/* The phase's own result, when it produced one. What the phase MEANS belongs in the
                rail, where it is stated once — repeating it per row put the same sentence on screen
                twice and crowded out the summaries that differ from run to run. */}
            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500" title={t.summary || PHASE_BLURB[t.phase]}>
              {t.summary || ''}
            </span>
            {t.score != null && <span className="shrink-0 font-mono text-[10px] text-slate-500">{t.score}</span>}
            <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400">
              {/* An unmeasurable phase says so. A "0s" here would be a claim, not a gap. */}
              {t.ms != null ? secs(t.ms) : t.live && t.startedAt ? secs(Date.now() - t.startedAt) : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One bus event → one timeline entry, or null to drop it.
 *
 * The previous map covered thirteen event types out of the thirty-odd the bus emits, and none of
 * the ones produced during `implement` — which is the longest phase of a run and the only one where
 * files actually change. So for the minutes that matter most, the "live" flow showed nothing at all
 * and looked like a stalled page. Every event carrying information about work in progress is
 * mapped here now.
 */
const STAGE = (e) => {
  switch (e.type) {
    /* ── the iteration pipeline ─────────────────────────────────────────────── */
    case 'iteration.started': return { icon: '⟳', tint: 'sky', text: `iteration #${e.iterationId} started`, sub: e.trigger ? `triggered by ${e.trigger}` : '' };
    case 'iteration.phase':
      // The phase table above carries durations, so a bare "phase running" line would duplicate it.
      // A phase RESULT does not appear there in full, and a failure must never be filtered out.
      if (e.status === 'error') return { icon: '✕', tint: 'rose', text: `phase ${e.phase} failed`, sub: e.summary || '' };
      if (e.status === 'ok' && (e.summary || e.score != null)) {
        return { icon: '✓', tint: 'slate', text: `${e.phase} done${e.score != null ? ` · ${e.score}` : ''}`, sub: e.summary || '' };
      }
      return null;
    case 'iteration.finished': return { icon: e.status === 'committed' ? '✓' : '✕', tint: e.status === 'committed' ? 'emerald' : 'amber', text: `iteration #${e.iterationId} ${e.status}`, sub: e.total != null ? `score ${e.total}` : '' };

    /* ── the work itself: what the implementer is doing, task by task ───────── */
    case 'impl.task_started':
      return { icon: '▶', tint: 'violet', text: `task ${e.index}/${e.total}${e.agent ? ` · ${e.agent}` : ''}`, sub: e.title || '' };
    case 'impl.task_finished':
      return {
        icon: e.ok ? '✓' : '✕',
        tint: e.ok ? 'emerald' : 'rose',
        text: `task ${e.index || '?'} ${e.ok ? 'landed' : 'failed'}${e.files ? ` · ${e.files} file(s)` : ''}`,
        sub: e.reason || e.title || '',
      };
    // Individual tool calls, coalesced downstream — one per file edit is far too many lines, but
    // dropping them leaves a multi-minute silence in the middle of every run.
    case 'impl.tool':
      return { icon: '✎', tint: 'sky', text: e.tool, sub: e.path || e.taskTitle || '', coalesce: `tool:${e.taskTitle}` };

    /* ── the phases that used to be invisible ───────────────────────────────── */
    case 'survey.started': return { icon: '◎', tint: 'sky', text: 'surveying the codebase', sub: '' };
    case 'survey.finished': return { icon: '◎', tint: 'emerald', text: `survey added ${e.added ?? 0} item(s)`, sub: e.rejected ? `${e.rejected} rejected` : '' };
    case 'research.finished': return { icon: '⌕', tint: 'sky', text: `research · ${e.proposals ?? 0} proposal(s)`, sub: (e.topics || []).join(', ') };
    case 'workbench.check': return { icon: e.ok ? '✓' : '✕', tint: e.ok ? 'emerald' : 'rose', text: `workbench: ${e.name}`, sub: e.reason || e.detail || (e.ok ? 'serving' : 'not serving') };
    case 'workbench.healing': return { icon: '⚕', tint: 'amber', text: 'workbench self-healing', sub: e.reason || '' };
    case 'workbench.healed': return { icon: '⚕', tint: 'emerald', text: 'workbench healed', sub: e.detail || '' };

    /* ── the proposal agents ────────────────────────────────────────────────── */
    case 'orchestrator.tick': return e.skipped ? null : { icon: '↳', tint: 'sky', text: `Director scheduled ${e.agentId}`, sub: e.ranking ? `priorities ${e.ranking.join(' ')}` : '' };
    case 'agent.started': return { icon: '▶', tint: 'emerald', text: `${e.agentName || e.agentId} started`, sub: e.instruction || e.trigger };
    case 'agent.plan': return { icon: '◈', tint: 'violet', text: `${e.agentId} committed a plan`, sub: `[${e.criticality}] ${e.title}` };
    case 'agent.proposal_drafted': return { icon: '✎', tint: 'sky', text: `${e.agentId} drafting`, sub: e.path };
    case 'agent.critique': return { icon: '⚖', tint: 'amber', text: `${e.agentId} red-teaming its draft`, sub: '' };
    case 'agent.error': return { icon: '⚠', tint: 'rose', text: `${e.agentId} errored`, sub: e.error || '' };
    // The single most common stored event and, until now, the only one this map dropped: 384 of the
    // 400 rows on the real database were `agent.tool_call`, so a freshly loaded page showed the
    // handful of started/finished lines around them and nothing in between. Coalesced per agent,
    // the same rows read as "6 read_file · listings.js".
    case 'agent.tool_call':
      return { icon: '✎', tint: 'sky', text: e.tool, sub: e.args?.path || e.args?.title || e.args?.query || '', coalesce: `agent-tool:${e.agentId}:${e.tool}` };
    case 'agent.finished': return { icon: '■', tint: e.status === 'error' ? 'rose' : 'slate', text: `${e.agentId} finished`, sub: `${e.proposals} proposal(s) · ${e.steps} steps` };
    case 'verify.started': return e.inline ? { icon: '⚙', tint: 'slate', text: `${e.agentId} self-verifying`, sub: (e.paths || []).join(', ') } : null;
    case 'verify.finished': return e.inline ? { icon: e.ok ? '✓' : '✕', tint: e.ok ? 'emerald' : 'rose', text: `${e.agentId} self-verify ${e.ok ? 'passed' : 'failed'}`, sub: e.failed || '' } : null;
    case 'proposal.created': return { icon: '◆', tint: 'sky', text: `proposal #${e.proposalId}`, sub: e.title };
    case 'proposal.applied': return { icon: '⬆', tint: 'emerald', text: `landed #${e.proposalId}`, sub: e.ref };
    case 'proposal.rejected': return { icon: '⊘', tint: 'amber', text: `rejected #${e.proposalId}`, sub: e.reason || '' };
    case 'manager.message': return e.kind === 'decision' ? { icon: '🧭', tint: 'sky', text: `${e.from}: ${e.title || e.kind}`, sub: '' } : null;
    case 'reliability.applied': return { icon: '⚕', tint: 'emerald', text: 'reliability fix applied', sub: e.title || '' };

    /* ── the loop standing still, which is information when you are waiting ─── */
    case 'control.tick':
      if (e.skipped === 'not_leader') return { icon: '⏸', tint: 'amber', text: 'standing by', sub: `another process holds the loop (${e.leader || 'unknown'})` };
      if (e.skipped === 'daily_cap') return { icon: '⏸', tint: 'slate', text: 'daily cap reached', sub: `${e.todayCount}/${e.maxPerDay} runs today` };
      if (e.salvaging) return { icon: '↻', tint: 'sky', text: `resuming #${e.salvaging}`, sub: `${e.filesChanged} file(s) already changed · attempt ${e.attempt}` };
      return null;
    case 'control.loop': return { icon: e.running ? '▶' : '■', tint: e.running ? 'emerald' : 'slate', text: `loop ${e.running ? 'started' : 'stopped'}`, sub: '' };
    default: return null;
  }
};

/**
 * Collapse consecutive entries that carry the same `coalesce` key into one.
 *
 * The implementer emits a tool event per file operation, so a single task can produce dozens. Shown
 * one per line they push everything else off the screen; dropped entirely they leave the longest
 * phase of the run looking like nothing is happening. Folded, they read as one live line — "8 edits
 * · src/pay.js" — which is what an operator actually wants to know.
 *
 * Runs in chronological order, before the reverse, so "the first of a run" is the one kept and the
 * timestamp shown is the most recent activity in it.
 */
function coalesce(steps) {
  const out = [];
  for (const step of steps) {
    const key = step.s.coalesce;
    const prev = out[out.length - 1];
    if (key && prev?.s.coalesce === key) {
      prev.count = (prev.count || 1) + 1;
      prev.e = step.e; // the group is as recent as its latest member
      prev.s = { ...prev.s, sub: step.s.sub || prev.s.sub };
      continue;
    }
    out.push({ ...step, count: 1 });
  }
  return out;
}
