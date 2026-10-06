import { useEffect, useRef } from 'react';

/**
 * KEEP KEYBOARD FOCUS INSIDE AN OPEN OVERLAY, AND GIVE IT BACK ON CLOSE.
 *
 * Measured before writing this: the dashboard had **four** overlay components — ConfirmDialog,
 * CommandPalette, ProposalDetail and Chat — with four different half-implementations between them
 * (one had Escape but no dialog role, one had the role but never moved focus, one had neither) and
 * **not one focus trap**. Tab from inside any of them walks straight out into the page behind,
 * where a sighted mouse user sees a dimmed backdrop and a keyboard user is simply lost: the focus
 * ring is somewhere under the overlay, activating controls they cannot see.
 *
 * One hook rather than four fixes, because the divergence *is* the bug — each overlay had drifted
 * to a different subset of correct behaviour, and a fifth would have invented a fifth.
 *
 * What it does, in the order the browser needs it:
 *   1. remembers what had focus, so it can be handed back;
 *   2. moves focus into the overlay — the element marked `data-autofocus`, else the first control,
 *      else the container itself, which is why the container needs `tabIndex={-1}`;
 *   3. cycles Tab and Shift+Tab within the overlay;
 *   4. calls `onClose` on Escape;
 *   5. restores focus on unmount, **only if the original element is still in the document** — a
 *      trigger that was itself removed by the action would otherwise throw focus to `<body>`.
 *
 * @param {boolean}  active   whether the overlay is open
 * @param {Function} onClose  called on Escape; omit to leave Escape alone
 * @returns {object} ref to attach to the overlay container
 */
export function useFocusTrap(active, onClose) {
  const ref = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    const node = ref.current;
    if (!node) return undefined;

    restoreTo.current = document.activeElement;

    /*
     * Focusable, and actually reachable.
     *
     * `disabled`, `[hidden]` and `aria-hidden` are excluded because the browser skips them anyway —
     * including them would make Tab appear to stop working at the edge of the cycle.
     * `tabindex="-1"` is excluded for the same reason: programmatically focusable, not in the Tab
     * order.
     *
     * **Deliberately NOT `offsetParent !== null`.** That is the usual shorthand for "visible" and it
     * is wrong here twice over: it returns null for anything inside a `position: fixed` ancestor,
     * which is every overlay in this app, and jsdom has no layout engine so it is null for
     * everything. The first version used it and every trap silently found zero focusable elements —
     * caught by the tests, but it would have shipped as "Tab does nothing inside a dialog".
     */
    const focusable = () => [...node.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.hasAttribute('disabled') && !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');

    // An explicit `data-autofocus` beats the first control: in a search overlay the input is what
    // the operator wants, not whatever button happens to come first in the DOM.
    const initial = node.querySelector('[data-autofocus]') || focusable()[0] || node;
    // After paint — an element rendered in the same tick is not yet focusable in every browser.
    const raf = requestAnimationFrame(() => initial?.focus?.());

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (!items.length) {
        // Nothing to move to — keep focus on the container rather than letting it escape.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // `document.activeElement` rather than `e.target`: focus may sit on the container itself,
      // which is not in `items` and would otherwise fall through to the browser's default.
      const current = document.activeElement;

      if (e.shiftKey && (current === first || !node.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !node.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      node.removeEventListener('keydown', onKeyDown);
      const back = restoreTo.current;
      // Only if it is still there. An overlay whose trigger was a row that the action deleted has
      // nothing to return to, and focusing a detached node silently sends focus to <body>.
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [active, onClose]);

  return ref;
}
