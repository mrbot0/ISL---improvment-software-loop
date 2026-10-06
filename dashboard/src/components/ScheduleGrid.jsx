import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CardHead, Empty, Spinner } from './ui.jsx';

/**
 * Scheduler & windows visualiser (ISL_Frontend §15, P2).
 *
 * The window is four numbers — enabled, start hour, end hour, days — and reading four numbers is not
 * the same as knowing when the fleet will actually do maintenance work. The failure this prevents is
 * specific and easy to walk into: an **overnight window** (22 → 05) does not mean "Monday 22:00 to
 * Tuesday 05:00 if Monday is selected"; the early-morning hours belong to the PREVIOUS day's
 * selection. A grid makes that visible in a glance and a sentence never does.
 *
 * The grid recomputes membership with the same rule the server uses, rather than trusting a
 * summary, so what is painted is what will fire.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const TASK_LABEL = {
  deps: 'Dependency scan',
  coverage: 'Seed coverage tasks',
  structural: 'Seed refactor tasks',
  health: 'Health snapshot',
  crossProject: 'Cross-project transfer',
  embeddings: 'Build embeddings',
};

/**
 * Mirrors `inWindow` in improvementWindows.js, including the overnight case where the day check
 * applies to the side the hour falls on. Duplicating a rule is normally a smell; here the
 * alternative is a grid that paints something other than what fires, which is worse than duplication.
 */
function isInWindow({ enabled, startHour, endHour, days }, day, hour) {
  if (!enabled) return false;
  if (startHour < endHour) return days.includes(day) && hour >= startHour && hour < endHour;
  if (hour >= startHour) return days.includes(day);
  const prevDay = (day + 6) % 7;
  return hour < endHour && days.includes(prevDay);
}

export default function ScheduleGrid({ toast }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const now = new Date();

  const load = () => api.schedule().then(setS).catch(() => {});
  // `useEffect(load, [])` passes load's RETURN VALUE to React as the cleanup function. `load`
  // returns a promise, and React calls it on unmount — "destroy is not a function", every time the
  // view is left. The arrow discards the return value, which is all the effect ever wanted.
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setBusy(true);
    try { setS(await api.setSchedule(patch)); toast?.('Schedule updated', { type: 'success' }); load(); }
    catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); }
  };

  if (!s) return <div className="grid h-32 place-items-center"><Spinner /></div>;

  const overnight = s.startHour >= s.endHour;
  const enabledTasks = Object.entries(s.tasks || {}).filter(([, on]) => on);

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="card-head flex-wrap gap-y-1">
          <span className="card-title">Maintenance window</span>
          <span className={`pill ml-2 ${s.enabled ? (s.inWindow ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-600/20 text-slate-400') : 'bg-slate-600/20 text-slate-500'}`}>
            {!s.enabled ? 'disabled' : s.inWindow ? 'open now' : 'closed'}
          </span>
          {s.enabled && !s.inWindow && s.nextWindow && (
            <span className="ml-2 text-[11px] text-slate-500">next opens {new Date(s.nextWindow).toLocaleString()}</span>
          )}
          <div className="flex-1" />
          <button
            onClick={async () => { setBusy(true); try { const r = await api.runScheduleNow(); toast?.(`Ran ${r.ran?.length ?? 0} task(s) now`, { type: 'success' }); load(); } catch (e) { toast?.(e.message, { type: 'error' }); } finally { setBusy(false); } }}
            disabled={busy}
            className="btn-ghost text-[11px]"
            title="Run every enabled task immediately, ignoring the window"
          >
            ▶ run now
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-3 py-3 text-[12px]">
          <label className="flex cursor-pointer items-center gap-2 text-slate-400">
            <input type="checkbox" checked={!!s.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />
            enabled
          </label>
          <label className="flex items-center gap-1 text-slate-400">
            from
            <select value={s.startHour} disabled={busy} onChange={(e) => save({ startHour: Number(e.target.value) })} className="rounded bg-ink-900 px-1 py-0.5 text-slate-200">
              {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-slate-400">
            to
            <select value={s.endHour} disabled={busy} onChange={(e) => save({ endHour: Number(e.target.value) })} className="rounded bg-ink-900 px-1 py-0.5 text-slate-200">
              {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
          {/* The counter-intuitive case, named rather than left to be discovered. */}
          {overnight && (
            <span className="text-[11px] text-amber-300/80" title="The hours after midnight belong to the previous day's selection">
              ⓘ overnight window — the early hours count against the previous day
            </span>
          )}
        </div>

        {/* The grid. Rows are days, columns are hours; a painted cell will fire. */}
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full min-w-[560px] border-separate border-spacing-0.5">
            <thead>
              <tr>
                <th className="w-10" />
                {HOURS.map((h) => (
                  <th key={h} className="text-[10px] font-normal text-slate-600">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAY_NAMES.map((name, day) => {
                const selected = (s.days || []).includes(day);
                return (
                  <tr key={day}>
                    <td>
                      <button
                        onClick={() => save({ days: selected ? s.days.filter((d) => d !== day) : [...s.days, day] })}
                        disabled={busy}
                        className={`w-9 rounded px-1 py-0.5 text-[10px] ${selected ? 'bg-ink-700 text-slate-200' : 'text-slate-600 hover:text-slate-400'}`}
                        title={selected ? 'Click to exclude this day' : 'Click to include this day'}
                      >
                        {name}
                      </button>
                    </td>
                    {HOURS.map((h) => {
                      const on = isInWindow(s, day, h);
                      const isNow = day === now.getDay() && h === now.getHours();
                      return (
                        <td key={h} className="p-0">
                          <div
                            title={`${name} ${String(h).padStart(2, '0')}:00 — ${on ? 'window open' : 'closed'}`}
                            className={`h-4 rounded-sm ${on ? 'bg-emerald-500/60' : 'bg-ink-800'} ${isNow ? 'ring-1 ring-sky-400' : ''}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1 flex gap-3 text-[10px] text-slate-600">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/60" />window open</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-ink-800 ring-1 ring-sky-400" />now</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Tasks</span><span className="ml-2 text-[10px] text-slate-600">each fires at most once per calendar day, inside the window</span>
        </div>
        <div className="divide-y divide-ink-800">
          {Object.keys(TASK_LABEL).map((key) => {
            const on = !!s.tasks?.[key];
            const last = s.lastRuns?.[key];
            return (
              <div key={key} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                <input type="checkbox" checked={on} disabled={busy} onChange={(e) => save({ tasks: { [key]: e.target.checked } })} />
                <span className={`min-w-0 flex-1 ${on ? 'text-slate-200' : 'text-slate-600'}`}>{TASK_LABEL[key]}</span>
                {/* "Never" is a real answer and is said plainly — an empty cell would read as a
                    rendering gap rather than as information. */}
                <span className="text-[10px] text-slate-600">{last ? `last fired ${last}` : 'never fired'}</span>
              </div>
            );
          })}
        </div>
        {!enabledTasks.length && (
          <div className="px-3 py-4">
            <Empty icon="○" title="No task enabled" hint="The window can be open and still do nothing — a task must be selected above." />
          </div>
        )}
      </div>
    </div>
  );
}
