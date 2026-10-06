import { describe, it, expect } from 'vitest';
import { keysForEvent, EVENT_KEYS, MANAGER_KEYS, SAFETY_NET_MS, SAFETY_NET_LIVE_MS } from './liveKeys.js';

/**
 * This table is the whole reason eight views could stop polling. If an entry is wrong the failure is
 * SILENT — the page simply stops updating and looks like it is working — so the shape of every key
 * and the mapping of the events that actually drive the pipeline are pinned here.
 */
describe('event → resource mapping', () => {
  it('maps the events that change what a view is showing', () => {
    expect(keysForEvent({ type: 'iteration.finished' })).toContain('runs:*');
    expect(keysForEvent({ type: 'iteration.phase' })).toContain('iteration:*');
    expect(keysForEvent({ type: 'deploy.promoted' })).toContain('dora');
    expect(keysForEvent({ type: 'runtime.changed' })).toContain('runtime');
    expect(keysForEvent({ type: 'backlog.changed' })).toContain('backlog');
  });

  it('invalidates NOTHING for an event it does not model', () => {
    // The safe direction: an unknown event must not blow the whole cache away on every log line.
    expect(keysForEvent({ type: 'log' })).toEqual([]);
    expect(keysForEvent({ type: 'token' })).toEqual([]);
    expect(keysForEvent({ type: 'totally.made.up' })).toEqual([]);
  });

  it('survives a malformed event instead of throwing', () => {
    // These arrive off a socket. A missing field must not take the dashboard down.
    expect(keysForEvent(null)).toEqual([]);
    expect(keysForEvent(undefined)).toEqual([]);
    expect(keysForEvent({})).toEqual([]);
  });

  it('reads a manager brief by its manager, not its type', () => {
    expect(keysForEvent({ type: 'manager.brief', manager: 'Risk' })).toEqual(['security:risk']);
    expect(keysForEvent({ type: 'manager.brief', manager: 'Reliability' })).toEqual(['reliability:*']);
    // A manager with nothing cached about it invalidates nothing, rather than everything.
    expect(keysForEvent({ type: 'manager.brief', manager: 'Quality' })).toEqual([]);
    expect(keysForEvent({ type: 'manager.brief' })).toEqual([]);
  });

  it('wipes everything on a project switch — nothing cached is about the new codebase', () => {
    expect(keysForEvent({ type: 'project.switched' })).toEqual(['*']);
  });

  it('every key is a plain string, and a wildcard only ever trails', () => {
    for (const [event, keys] of Object.entries({ ...EVENT_KEYS, ...MANAGER_KEYS })) {
      for (const k of keys) {
        expect(typeof k, `${event} → ${k}`).toBe('string');
        expect(k.length, `${event} has an empty key`).toBeGreaterThan(0);
        // `invalidateResource` only understands a trailing '*'; one in the middle would silently
        // match nothing, which is exactly the kind of dead mapping this test exists to catch.
        expect(k.indexOf('*'), `${event} → ${k} has a non-trailing wildcard`).toBe(k.includes('*') ? k.length - 1 : -1);
      }
    }
  });

  it('keeps the safety net far slower than the polling it replaced', () => {
    // The old timers ran at 3–6s. If these ever drop back into that range the polling is back,
    // just spelled differently.
    expect(SAFETY_NET_LIVE_MS).toBeGreaterThanOrEqual(15_000);
    expect(SAFETY_NET_MS).toBeGreaterThanOrEqual(SAFETY_NET_LIVE_MS);
  });
});
