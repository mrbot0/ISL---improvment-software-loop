import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap.js';

/**
 * Focus stays inside an open overlay, and comes back when it closes.
 *
 * Measured before this existed: the dashboard had four overlays — ConfirmDialog, CommandPalette,
 * ProposalDetail, Chat — with four different partial implementations and **not one focus trap**.
 * Tab from inside any of them walked out into the page behind, leaving a keyboard user with the
 * focus ring on controls hidden under a dimmed backdrop.
 *
 * **What jsdom can and cannot show.** It has no native Tab navigation, so these fire the keydown
 * the trap listens for and assert what the trap itself does. That covers every branch the hook
 * owns — the boundary wrap, Escape, the initial focus, the restore — and deliberately does not
 * claim to test the browser's own tab order in between, which is not in play here.
 */

function Overlay({ onClose, withAutofocus = false, empty = false }) {
  const ref = useFocusTrap(true, onClose);
  return (
    <div>
      <button>outside before</button>
      <div ref={ref} tabIndex={-1} role="dialog" aria-label="test overlay" data-testid="overlay">
        {!empty && (
          <>
            <button>first</button>
            <button {...(withAutofocus ? { 'data-autofocus': true } : {})}>middle</button>
            <button>last</button>
          </>
        )}
      </div>
      <button>outside after</button>
    </div>
  );
}

const tab = (opts = {}) => fireEvent.keyDown(document.activeElement, { key: 'Tab', ...opts });

describe('useFocusTrap', () => {
  it('moves focus into the overlay when it opens', async () => {
    render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
  });

  it('honours data-autofocus over document order', async () => {
    // A search overlay wants its input focused, not whichever button is first in the DOM.
    render(<Overlay withAutofocus />);
    await waitFor(() => expect(screen.getByText('middle')).toHaveFocus());
  });

  it('CYCLES from the last element back to the first', async () => {
    // The defect this exists for: without the wrap, Tab here reaches "outside after".
    render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());

    screen.getByText('last').focus();
    tab();
    expect(screen.getByText('first')).toHaveFocus();
  });

  it('cycles backwards from the first element to the last', async () => {
    render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());

    tab({ shiftKey: true });
    expect(screen.getByText('last')).toHaveFocus();
  });

  it('pulls focus back in if it has escaped the overlay', async () => {
    // Focus can end up outside by other means — a click on the page, a programmatic focus. The next
    // Tab must recover rather than continue from wherever it landed.
    render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());

    const overlay = screen.getByTestId('overlay');
    screen.getByText('outside after').focus();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(screen.getByText('first')).toHaveFocus();
  });

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone when no handler was given', async () => {
    // An overlay that closes some other way must not have its Escape swallowed.
    render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
    expect(() => fireEvent.keyDown(document.activeElement, { key: 'Escape' })).not.toThrow();
  });

  it('returns focus to whatever had it before', async () => {
    // The second half of the bug: a user who opens a dialog from a table row and closes it should
    // be back on that row, not at the top of the document.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
    unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it('does not throw when the trigger has been removed from the page', async () => {
    // An overlay opened from a row that the action then deletes has nothing to return to.
    // Focusing a detached node silently sends focus to <body>, so the guard has to be explicit.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(<Overlay />);
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
    trigger.remove();
    expect(() => unmount()).not.toThrow();
  });

  it('keeps focus on the container when the overlay has no controls', async () => {
    // A dialog rendering only a spinner still must not leak focus to the page behind it.
    render(<Overlay empty />);
    const overlay = screen.getByTestId('overlay');
    await waitFor(() => expect(overlay).toHaveFocus());

    tab();
    expect(overlay).toHaveFocus();
  });
});
