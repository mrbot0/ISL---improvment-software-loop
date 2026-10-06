import { useCallback, useState } from 'react';
import { useFocusTrap } from '../useFocusTrap.js';

/**
 * useConfirm — a promise-based confirmation dialog (ISL_Frontend §6, §2).
 *
 * Replaces `window.confirm` (which is ugly, blocking and un-styleable) with an accessible
 * modal: focus moves to the confirm button, Escape/backdrop cancel, `role="dialog"` +
 * `aria-modal`. Usage:
 *
 *   const [confirm, confirmUI] = useConfirm();
 *   ...
 *   {confirmUI}
 *   onClick={async () => { if (await confirm({ title, message, confirmLabel })) doIt(); }}
 */
export function useConfirm() {
  const [req, setReq] = useState(null);
  const confirm = useCallback((opts = {}) => new Promise((resolve) => setReq({ ...opts, resolve })), []);
  const close = (val) => {
    req?.resolve(val);
    setReq(null);
  };
  const ui = req ? <ConfirmDialog {...req} onCancel={() => close(false)} onConfirm={() => close(true)} /> : null;
  return [confirm, ui];
}

function ConfirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger', onCancel, onConfirm }) {
  /*
   * The trap replaces a hand-rolled focus + Escape pair that did two of the five things a modal
   * owes a keyboard user. It moved focus in and closed on Escape — and Tab walked straight out
   * behind the backdrop, leaving the focus ring on controls hidden under a dimmed overlay, with no
   * way back and no way to see where you were.
   *
   * `data-autofocus` on the confirm button preserves the one behaviour worth keeping: the dialog
   * opens with the affirmative action focused, not with whatever is first in the DOM.
   */
  const trapRef = useFocusTrap(true, onCancel);

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      ref={trapRef}
      // Focusable so the trap has somewhere to park focus if the dialog ever renders no controls.
      tabIndex={-1}
    >
      <div className="card w-full max-w-sm p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-semibold text-white">{title}</div>
        {message && <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">{message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="btn-ghost">{cancelLabel}</button>
          <button data-autofocus onClick={onConfirm} className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
