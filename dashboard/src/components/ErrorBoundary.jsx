import { Component } from 'react';
import { isStaleChunkError, reloadForNewBuild } from '../lazyView.js';

/**
 * Route-level ERROR BOUNDARY (ISL_Frontend §4). A crash in one view (a bad render, an
 * unexpected shape from the API, LLM data rendered as a child) used to blank the whole
 * screen. Now it's caught: the shell survives, the view shows a friendly error + a reload,
 * and navigating away clears it (each view gets a fresh boundary via `key={view}`).
 *
 * ONE ERROR IS NOT LIKE THE OTHERS. "Failed to fetch dynamically imported module" means the tab is
 * holding an `index.html` from a previous build and asking for a chunk filename that no longer
 * exists. Remounting the view — which is all "Reload view" ever did — re-requests the same missing
 * file and fails identically, so the button was a no-op for the one error an operator hits most on a
 * control plane that redeploys while they watch it. Only a real page load fixes it.
 */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('A view crashed and was contained by the error boundary:', error, info?.componentStack);
    // Recover without making the operator read a stack trace about a build they did not know changed.
    // Guarded against looping: if the fresh page fails the same way, the error is shown instead.
    if (isStaleChunkError(error)) reloadForNewBuild();
  }

  reset = () => {
    if (isStaleChunkError(this.state.error) && reloadForNewBuild()) return;
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const stale = isStaleChunkError(this.state.error);
      return (
        <div className="grid h-full place-items-center p-8 text-center" role="alert">
          <div className="max-w-md">
            <div className="text-3xl">{stale ? '↻' : '💥'}</div>
            <div className="mt-2 text-[14px] font-semibold text-white">
              {stale ? 'This page is from an older build' : 'This view hit an error'}
            </div>
            <p className="mt-1 break-words text-[12px] text-slate-500">
              {stale
                ? 'ISL was updated while this tab was open, so part of it is no longer on the server. Reloading picks up the new version — nothing is lost.'
                : String(this.state.error?.message || this.state.error).slice(0, 240)}
            </p>
            <button onClick={this.reset} className="btn-primary mt-4">
              {stale ? 'Reload the page' : 'Reload view'}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
