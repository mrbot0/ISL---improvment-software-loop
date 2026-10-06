export const AGENT_META = {
  security: { emoji: '🛡️', tint: 'text-rose-300' },
  tests: { emoji: '🧪', tint: 'text-sky-300' },
  performance: { emoji: '⚡', tint: 'text-amber-300' },
  quality: { emoji: '🧹', tint: 'text-violet-300' },
  frontend: { emoji: '♿', tint: 'text-teal-300' },
  services: { emoji: '🔗', tint: 'text-cyan-300' },
  workbench: { emoji: '🔧', tint: 'text-orange-300' },
  research: { emoji: '🌐', tint: 'text-indigo-300' },
  resilience: { emoji: '🩺', tint: 'text-rose-300' },
  compliance: { emoji: '📋', tint: 'text-teal-300' },
  docs: { emoji: '📝', tint: 'text-slate-300' },
  infra: { emoji: '🚀', tint: 'text-sky-300' },
  refactor: { emoji: '🧱', tint: 'text-violet-300' },
  ux: { emoji: '✨', tint: 'text-amber-300' },
};

const STATUS_STYLES = {
  verifying: 'bg-sky-500/15 text-sky-300',
  verified: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
  approved: 'bg-emerald-500/25 text-emerald-200',
  applied: 'bg-emerald-600/25 text-emerald-200',
  apply_failed: 'bg-rose-600/25 text-rose-200',
  rejected: 'bg-slate-500/15 text-slate-400',
  stale: 'bg-amber-500/15 text-amber-300',
  idea: 'bg-indigo-500/15 text-indigo-300',
};

const SEVERITY_STYLES = {
  critical: 'bg-rose-600/25 text-rose-200',
  high: 'bg-orange-500/20 text-orange-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-slate-500/15 text-slate-400',
};

export const StatusPill = ({ status }) => (
  <span className={`pill ${STATUS_STYLES[status] ?? 'bg-slate-500/15 text-slate-400'}`}>
    {status.replace('_', ' ')}
  </span>
);

export const SeverityPill = ({ severity }) => (
  <span className={`pill ${SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low}`}>{severity}</span>
);

export const Churn = ({ additions, deletions }) => (
  <span className="font-mono text-[11px]">
    <span className="text-emerald-400">+{additions}</span>
    <span className="text-slate-600">/</span>
    <span className="text-rose-400">−{deletions}</span>
  </span>
);

export function ago(ts, fallback = 'never') {
  /*
   * A MISSING TIMESTAMP MUST NOT RENDER AS A NUMBER.
   *
   * `Date.now() - undefined` is NaN, every comparison against NaN is false, and the function fell
   * through to its last line — printing **"NaNd ago"** on screen. Compliance showed exactly that for
   * "Last run" before an audit had ever been run: the honest answer is "never", and instead the page
   * showed a broken number that looks like a bug in the product rather than an absent value.
   *
   * There are 29 call sites across 22 files, and any of them can be handed a null timestamp by an
   * endpoint that has nothing to report yet — so the guard belongs here, once, not at each caller.
   */
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;

  const s = Math.floor((Date.now() - n) / 1000);
  // A timestamp in the future is a clock skew between the server and the browser, not a negative
  // age. Clamping to 0 said "0s ago", which is at least true.
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const Spinner = ({ className = '' }) => (
  <svg className={`h-3.5 w-3.5 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-90" d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

/**
 * The empty state. Pass children for a one-liner, or icon/title/hint when the
 * emptiness deserves an explanation — "nothing here" is rarely the whole story,
 * and an operator staring at a blank panel wants to know whether that is good news.
 */
export const Empty = ({ children, icon, title, hint }) => (
  <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 px-6 py-6 text-center">
    {icon && <div className="text-2xl opacity-40">{icon}</div>}
    {title && <div className="text-[13px] font-medium text-slate-400">{title}</div>}
    {hint && <div className="max-w-md text-[11px] leading-relaxed text-slate-600">{hint}</div>}
    {children && <div className="text-xs text-slate-600">{children}</div>}
  </div>
);

/**
 * The one page header every view should use (ISL_Frontend §1): a title, an optional
 * one-line description, and an actions slot. Keeps titles/spacing consistent instead of
 * each view hand-rolling its own heading.
 */
export const PageHeader = ({ title, subtitle, children }) => (
  <div className="flex flex-wrap items-start justify-between gap-2">
    <div className="min-w-0">
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-sub">{subtitle}</p>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>
);

/**
 * The header every panel already draws by hand (ISL_Frontend §1 P0).
 *
 * `<div className="card-head"><span className="card-title">…</span><div className="flex-1" />…</div>`
 * appears **50 times across 19 views**. The CSS was already shared, so this is not about styling —
 * it is about two things the copies get wrong identically:
 *
 *   1. `<span>` IS NOT A HEADING. Fifty panel titles were spans, so a screen-reader user navigating
 *      the dashboard by heading found nothing below the page title. axe does not flag this (a span
 *      is not a heading out of order, it is simply absent), which is exactly why it survived an
 *      automated audit and needed someone to look.
 *   2. The `flex-1` spacer that pushes actions right was hand-written every time, and forgetting it
 *      silently left-aligns a panel's controls.
 *
 * `level` exists because heading order has to make sense per page: a panel inside a section may need
 * an h3 where a top-level panel wants an h2.
 */
export const CardHead = ({ title, level = 2, children, className = '' }) => {
  const H = `h${Math.min(6, Math.max(2, level))}`;
  return (
    <div className={`card-head ${className}`}>
      <H className="card-title">{title}</H>
      {children != null && <><div className="flex-1" />{children}</>}
    </div>
  );
};

/**
 * A skeleton placeholder — better perceived performance than a spinner because it hints
 * at the shape of the content that's loading. `rows` stacked bars, or pass a className.
 */
export const Skeleton = ({ rows = 3, className = '' }) => (
  <div className={`space-y-2 ${className}`} aria-hidden="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="skeleton h-8 w-full" style={{ opacity: 1 - i * 0.12 }} />
    ))}
  </div>
);
