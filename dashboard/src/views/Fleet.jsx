import AgentCard from '../components/AgentCard.jsx';
import { AGENT_META, ago } from '../components/ui.jsx';

/** Fleet view: the five worker agents, each editable, plus a per-agent scoreboard. */
export default function Fleet({ agents, orchestrator, metrics, thoughts, runs, actions }) {
  const runningId = orchestrator?.current?.agentId;
  const queued = new Set(orchestrator?.fleet?.queued ?? []);
  const byAgent = Object.fromEntries((metrics?.byAgent || []).map((a) => [a.agentId, a]));
  const lastRun = {};
  for (const r of runs || []) if (!lastRun[r.agentId]) lastRun[r.agentId] = r;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {agents.map((a) => {
        const stats = byAgent[a.id] || {};
        const lr = lastRun[a.id];
        return (
          <div key={a.id} className="space-y-2">
            <AgentCard
              agent={a}
              isRunning={runningId === a.id}
              isQueued={queued.has(a.id)}
              liveThought={thoughts[a.id]}
              onUpdate={actions.updateAgent}
              onRun={actions.runAgent}
            />
            <div className="flex items-center gap-3 px-3 text-[10px] text-slate-600">
              <span><span className="text-slate-400">{stats.proposals || 0}</span> proposals</span>
              <span><span className="text-emerald-400">{stats.applied || 0}</span> landed</span>
              <span><span className="text-slate-400">{stats.rejected || 0}</span> rejected</span>
              <span><span className="text-violet-400">{stats.pending || 0}</span> pending</span>
              <div className="flex-1" />
              {lr && <span>last run {ago(lr.startedAt)} · {lr.status}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
