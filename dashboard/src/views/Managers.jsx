import { accentHex } from '../components/charts.jsx';
import { ago } from '../components/ui.jsx';

const STATUS = {
  idle: { label: 'idle', cls: 'bg-slate-500/15 text-slate-400' },
  watching: { label: 'watching', cls: 'bg-sky-500/15 text-sky-300' },
  acting: { label: 'acting', cls: 'bg-violet-500/20 text-violet-300 animate-pulse' },
  alert: { label: 'alert', cls: 'bg-rose-500/20 text-rose-300' },
};

const SEV = {
  info: 'text-slate-500',
  warn: 'text-amber-400',
  error: 'text-rose-400',
  critical: 'text-rose-300 font-semibold',
};

/** Render a manager's free-form stats object as small labelled figures. */
function Stats({ stats }) {
  const entries = Object.entries(stats || {}).filter(
    ([, v]) => v != null && typeof v !== 'object',
  );
  if (!entries.length) return null;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      {entries.slice(0, 6).map(([k, v]) => (
        <div key={k} className="rounded-lg bg-ink-800/60 px-2 py-1.5">
          <div className="text-sm font-semibold tabular-nums text-slate-200">{typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}</div>
          <div className="truncate text-[10px] uppercase tracking-wide text-slate-500">{k.replace(/([A-Z])/g, ' $1')}</div>
        </div>
      ))}
    </div>
  );
}

function ManagerCard({ brief }) {
  const st = STATUS[brief.status] || STATUS.idle;
  const hex = accentHex(brief.accent);
  return (
    <div className="card p-4" style={{ borderColor: brief.status === 'alert' ? hex + '66' : undefined }}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg" style={{ background: hex + '1a' }}>
          {brief.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{brief.name}</h3>
            <span className={`pill ${st.cls}`}>{st.label}</span>
            <div className="flex-1" />
            <span className="text-[10px] text-slate-600">{brief.updatedAt ? ago(brief.updatedAt) : ''}</span>
          </div>
          <p className="text-[10px] text-slate-500">{brief.role}</p>
        </div>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-slate-300">{brief.headline}</p>
      <Stats stats={brief.stats} />

      {brief.recommendations?.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-ink-800 pt-2.5">
          {brief.recommendations.map((r, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-slate-400">
              <span style={{ color: hex }}>▸</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Managers({ managers }) {
  const briefs = managers?.briefs || [];
  const messages = managers?.messages || [];

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Supervisory managers</h2>
          <span className="text-[10px] text-slate-600">observe the fleet · coordinate · Operations can pause the loop</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {briefs.map((b) => <ManagerCard key={b.name} brief={b} />)}
          {!briefs.length && <div className="card p-6 text-center text-xs text-slate-600">Managers are starting…</div>}
        </div>
      </div>

      <div className="card flex min-h-[300px] flex-col">
        <div className="border-b border-ink-800 px-3 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Coordination log</h2>
          <p className="text-[10px] text-slate-600">messages managers send each other</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {!messages.length ? (
            <div className="grid h-full place-items-center text-xs text-slate-600">No coordination messages yet.</div>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => (
                <li key={m.id} className="text-[11px] leading-relaxed">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-slate-300">{m.from}</span>
                    <span className="text-slate-600">→</span>
                    <span className="text-slate-400">{m.to}</span>
                    <span className={`ml-auto ${SEV[m.severity] || SEV.info}`}>{m.kind}</span>
                  </div>
                  {m.title && <div className={`mt-0.5 ${SEV[m.severity] || 'text-slate-400'}`}>{m.title}</div>}
                  <div className="text-[10px] text-slate-700">{ago(m.ts)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
