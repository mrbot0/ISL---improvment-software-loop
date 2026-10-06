import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

const STYLE = {
  success: { icon: '✓', ring: 'border-emerald-700/60', dot: 'text-emerald-400' },
  error: { icon: '✕', ring: 'border-rose-700/60', dot: 'text-rose-400' },
  warn: { icon: '!', ring: 'border-amber-700/60', dot: 'text-amber-400' },
  info: { icon: '•', ring: 'border-ink-600', dot: 'text-sky-400' },
};

let seq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (message, { type = 'info', title, ttl = 4500 } = {}) => {
      const id = ++seq;
      setToasts((t) => [...t, { id, message, type, title }].slice(-5));
      if (ttl) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => {
          const s = STYLE[t.type] || STYLE.info;
          return (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto animate-slideIn rounded-xl border ${s.ring} bg-ink-900/95 px-3.5 py-2.5 shadow-2xl backdrop-blur`}
            >
              <div className="flex items-start gap-2.5">
                <span className={`mt-0.5 text-sm font-bold ${s.dot}`}>{s.icon}</span>
                <div className="min-w-0 flex-1">
                  {t.title && <div className="text-[12px] font-semibold text-white">{t.title}</div>}
                  <div className="break-words text-[11px] text-slate-400">{t.message}</div>
                </div>
                <button onClick={() => dismiss(t.id)} className="text-slate-600 hover:text-slate-300" aria-label="Dismiss">
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
