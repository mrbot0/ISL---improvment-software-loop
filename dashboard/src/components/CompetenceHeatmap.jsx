import { useMemo, useState } from 'react';
import { Empty } from './ui.jsx';

/**
 * Agent × area competence heatmap with drill-down (ISL_Frontend §15, P2).
 *
 * The routing and auto-land decisions are driven by which agent has earned competence where. That
 * was readable only as two flat lists ("strongest pairs", "weakest pairs"), which answers a question
 * nobody asked — the useful question is "who should own THIS area?" and its shape is a matrix.
 *
 * The honesty problem a heatmap invites is colour: a cell with one attempt and one landing is 100%
 * and would burn bright green next to a cell with fifty attempts at 70%, which is far stronger
 * evidence. So **confidence is encoded separately from rate**: colour carries the land rate, opacity
 * carries the sample size, and a cell below the evidence threshold is drawn as explicitly
 * insufficient rather than as a colour that would mislead.
 */

const MIN_ATTEMPTS = 3; // below this a rate is noise, and is shown as such

/**
 * Every class is spelled out literally.
 *
 * Tailwind compiles what it finds in the SOURCE, so a constructed name like `bg-${hue}-${step}`
 * exists at runtime and not in the stylesheet — the heatmap would have rendered entirely colourless
 * while every value looked correct in the DOM. Nine literals are the cost of the thing actually
 * having colour.
 */
const SHADE = {
  emerald: ['bg-emerald-500/20', 'bg-emerald-500/40', 'bg-emerald-500/70'],
  amber: ['bg-amber-500/20', 'bg-amber-500/40', 'bg-amber-500/70'],
  rose: ['bg-rose-500/20', 'bg-rose-500/40', 'bg-rose-500/70'],
};

/** Colour by land rate; intensity by how much evidence stands behind it. */
function cellStyle(cell) {
  if (!cell || !cell.attempts) return { className: 'bg-ink-800/40', title: 'no attempts' };
  if (cell.attempts < MIN_ATTEMPTS) {
    return {
      className: 'bg-slate-600/20 text-slate-500',
      title: `${cell.landed}/${cell.attempts} landed — too few attempts to judge`,
    };
  }
  const r = cell.landRate ?? 0;
  const hue = r >= 0.6 ? 'emerald' : r >= 0.35 ? 'amber' : 'rose';
  // 3 attempts → faint, 12+ → full. Evidence, not rate, drives how loudly a cell speaks.
  const strength = Math.min(1, cell.attempts / 12);
  const idx = strength > 0.66 ? 2 : strength > 0.33 ? 1 : 0;
  return {
    className: `${SHADE[hue][idx]} text-slate-100`,
    title: `${Math.round(r * 100)}% — ${cell.landed}/${cell.attempts} landed`,
  };
}

export default function CompetenceHeatmap({ network }) {
  const [picked, setPicked] = useState(null); // { agent, area }

  const { agents, areas, byPair } = useMemo(() => {
    const map = new Map();
    for (const c of network?.cells || []) map.set(`${c.agent}:${c.area}`, c);
    return {
      agents: network?.agents || [],
      areas: network?.areas || [],
      byPair: map,
    };
  }, [network]);

  if (!agents.length || !areas.length) {
    return <Empty icon="◫" title="No competence data yet" hint="The matrix fills in as agents attempt work across areas." />;
  }

  const cell = picked ? byPair.get(`${picked.agent}:${picked.area}`) : null;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-separate border-spacing-0.5 text-[11px]">
          <thead>
            <tr>
              <th className="w-28 text-left font-normal text-slate-600">agent \ area</th>
              {areas.map((a) => (
                <th key={a} className="px-1 pb-1 text-left font-normal text-slate-500">
                  <span className="block max-w-[70px] truncate" title={a}>{a}</span>
                </th>
              ))}
              <th className="w-16 text-right font-normal text-slate-600">overall</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((row) => (
              <tr key={row.agent}>
                <td className="max-w-[110px] truncate pr-2 text-slate-300" title={row.agent}>{row.agent}</td>
                {areas.map((area) => {
                  const c = byPair.get(`${row.agent}:${area}`);
                  const st = cellStyle(c);
                  const isPicked = picked?.agent === row.agent && picked?.area === area;
                  return (
                    <td key={area} className="p-0">
                      <button
                        onClick={() => setPicked(isPicked ? null : { agent: row.agent, area })}
                        title={`${row.agent} · ${area} — ${st.title}`}
                        className={`h-6 w-full rounded-sm text-[10px] ${st.className} ${isPicked ? 'ring-1 ring-sky-400' : ''}`}
                      >
                        {c?.attempts ? (c.attempts < MIN_ATTEMPTS ? '·' : `${Math.round((c.landRate ?? 0) * 100)}`) : ''}
                      </button>
                    </td>
                  );
                })}
                <td className="pl-2 text-right tabular-nums text-slate-400">
                  {row.attempts >= MIN_ATTEMPTS ? `${Math.round((row.landRate ?? 0) * 100)}%` : <span className="text-slate-600">n/a</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3 text-[10px] text-slate-600">
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-500/70" />≥60% landed</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-amber-500/70" />35–60%</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-rose-500/70" />&lt;35%</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-slate-600/20" />fewer than {MIN_ATTEMPTS} attempts — not judged</span>
        <span className="text-slate-700">paler = less evidence behind the rate</span>
      </div>

      {/* Drill-down: a heatmap that cannot be interrogated is decoration. */}
      {picked && (
        <div className="rounded-lg border border-ink-800 bg-ink-950/50 px-3 py-2 text-[11px]">
          <span className="text-slate-300">{picked.agent}</span>
          <span className="text-slate-600"> · </span>
          <span className="text-slate-300">{picked.area}</span>
          {cell?.attempts ? (
            <div className="mt-1 text-slate-400">
              {cell.landed} landed / {cell.failed} failed over {cell.attempts} attempt(s) —{' '}
              {cell.attempts < MIN_ATTEMPTS
                ? <span className="text-amber-300/90">too few attempts to draw a conclusion</span>
                : <span>{Math.round((cell.landRate ?? 0) * 100)}% land rate</span>}
            </div>
          ) : (
            <div className="mt-1 text-slate-500">This agent has never attempted work in this area.</div>
          )}
        </div>
      )}
    </div>
  );
}
