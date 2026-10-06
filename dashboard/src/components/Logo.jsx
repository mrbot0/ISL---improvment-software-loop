import { useId } from 'react';

/**
 * The ISL mark — a software-improvement loop that visibly *ascends*.
 *
 * The old mark was a flat ring: a cycle that returns to where it started, which is the wrong story
 * for a system whose whole claim is that each pass leaves the codebase better. This version keeps
 * the loop but opens it into a rising spiral, with three ticks marking the iterations that landed
 * and a bright core for the code under improvement. A gradient gives it depth at 28px without any
 * raster asset — it stays crisp at every size and renders identically offline.
 *
 * `tone="brand"` is the product treatment; `tone="cream"` is light-on-dark (login, print).
 * `useId()` keeps the gradient ids unique so several marks on one page never collide.
 */
export function LogoMark({ size = 28, tone = 'brand', className = '', animated = false }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gid = `isl-g-${uid}`;
  const glow = `isl-glow-${uid}`;
  const isCream = tone === 'cream';
  const c1 = isCream ? 'rgb(var(--cream))' : 'rgb(var(--brand))';
  const c2 = isCream ? 'rgb(var(--brand))' : 'rgb(var(--cream))';

  return (
    <svg
      viewBox="0 0 400 400" width={size} height={size} className={className}
      role="img" aria-label="ISL — Improvement Software Loop"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor={c1} stopOpacity="0.55" />
          <stop offset="55%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0%" stopColor={c2} stopOpacity="0.9" />
          <stop offset="70%" stopColor={c2} stopOpacity="0.15" />
          <stop offset="100%" stopColor={c2} stopOpacity="0" />
        </radialGradient>
      </defs>

      <g transform="translate(200,200)">
        {/* soft core glow — reads as "live" without any animation */}
        <circle cx="0" cy="0" r="96" fill={`url(#${glow})`} />

        {/* the improvement loop: an open cycle that rises rather than closing flat */}
        <path
          d="M 118,-46 A 132,132 0 1 1 34,-128"
          fill="none" stroke={`url(#${gid})`} strokeWidth="36" strokeLinecap="round"
        >
          {animated && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="9s" repeatCount="indefinite" />}
        </path>

        {/* the arrowhead: the next pass entering, one step HIGHER than it left */}
        <path d="M 8,-158 L 74,-120 L 44,-62 Z" fill={c2} />

        {/* three ticks — the iterations that landed, ascending to the right */}
        <g fill={c1} opacity="0.9">
          <rect x="-64" y="12" width="26" height="34" rx="7" />
          <rect x="-16" y="-14" width="26" height="60" rx="7" />
          <rect x="32" y="-42" width="26" height="88" rx="7" />
        </g>
      </g>
    </svg>
  );
}

/** The full lockup: mark + wordmark, in the brand's display face. */
export function Logo({ size = 28, subtitle = 'Improvement Loop', className = '', animated = false }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} animated={animated} />
      <div className="leading-none">
        <div className="font-display text-[19px] tracking-[0.12em] text-white">
          IS<span className="text-brand">L</span>
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{subtitle}</div>
        )}
      </div>
    </div>
  );
}

export default Logo;
