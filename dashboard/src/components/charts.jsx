/**
 * Dependency-free SVG charts. Kept deliberately small and self-contained — the
 * whole system avoids heavyweight deps, and a chart lib would dwarf everything else.
 * Colours come from CSS variables so light/dark and accents stay consistent.
 */

const ACCENT = {
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185',
  sky: '#38bdf8',
  violet: '#a78bfa',
  slate: '#94a3b8',
  teal: '#2dd4bf',
};

export const accentHex = (name) => ACCENT[name] ?? ACCENT.slate;

/** Sparkline / area chart for a single series. */
export function AreaChart({ data, xKey = 't', series = [], height = 120, className = '' }) {
  const w = 600;
  const h = height;
  const pad = { top: 8, right: 8, bottom: 18, left: 8 };
  const iw = w - pad.left - pad.right;
  const ih = h - pad.top - pad.bottom;

  if (!data?.length) return <div className={`grid place-items-center text-xs text-slate-600 ${className}`} style={{ height }}>no data yet</div>;

  const maxY = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] || 0)));
  const x = (i) => pad.left + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => pad.top + ih - (v / maxY) * ih;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`w-full ${className}`} preserveAspectRatio="none" style={{ height }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad.left} x2={w - pad.right} y1={pad.top + ih * f} y2={pad.top + ih * f} stroke="#252b3a" strokeWidth="1" />
      ))}
      {series.map((s) => {
        const hex = accentHex(s.accent);
        const pts = data.map((d, i) => `${x(i)},${y(d[s.key] || 0)}`);
        const area = `M ${pad.left},${pad.top + ih} L ${pts.join(' L ')} L ${x(data.length - 1)},${pad.top + ih} Z`;
        return (
          <g key={s.key}>
            <path d={area} fill={hex} opacity="0.12" />
            <polyline points={pts.join(' ')} fill="none" stroke={hex} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {data.length <= 2 && data.map((d, i) => <circle key={i} cx={x(i)} cy={y(d[s.key] || 0)} r="2.5" fill={hex} />)}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bars, one per row. */
export function BarChart({ rows, height, className = '' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={`space-y-2 ${className}`} style={height ? { height, overflowY: 'auto' } : undefined}>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[11px]">
          <span className="w-24 shrink-0 truncate text-slate-400" title={r.label}>{r.label}</span>
          <div className="relative h-4 flex-1 overflow-hidden rounded bg-ink-800">
            <div
              className="absolute inset-y-0 left-0 rounded"
              style={{ width: `${(r.value / max) * 100}%`, background: accentHex(r.accent) + '55', borderRight: `2px solid ${accentHex(r.accent)}` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right font-mono text-slate-300">{r.value}</span>
        </div>
      ))}
      {!rows.length && <div className="py-4 text-center text-xs text-slate-600">no data yet</div>}
    </div>
  );
}

/** Donut for a small set of categories. */
export function Donut({ segments, size = 132, thickness = 16, centerLabel, centerValue }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" style={{ width: size, height: size }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1a1f2b" strokeWidth={thickness} />
        {total > 0 &&
          segments.map((s, i) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={accentHex(s.accent)}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute text-center">
        <div className="text-lg font-bold text-white">{centerValue ?? total}</div>
        {centerLabel && <div className="text-[10px] uppercase tracking-wide text-slate-500">{centerLabel}</div>}
      </div>
    </div>
  );
}

/** A tiny inline sparkline for KPI tiles. */
export function Sparkline({ data = [], accent = 'slate', width = 96, height = 24 }) {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 2) - 1}`);
  const hex = accentHex(accent);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none" className="overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke={hex} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
      <circle cx={width} cy={height - (data[data.length - 1] / max) * (height - 2) - 1} r="1.8" fill={hex} />
    </svg>
  );
}

/** A big number with a label and optional sublabel — the KPI tile. */
export function Kpi({ label, value, sub, accent = 'slate', icon, spark }) {
  return (
    <div className="card p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {icon && <span className="text-sm opacity-70">{icon}</span>}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-2xl font-bold tabular-nums" style={{ color: accentHex(accent) }}>{value}</div>
        {spark?.length > 1 && <Sparkline data={spark} accent={accent} />}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}
