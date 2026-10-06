import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectEvents } from './api.js';

const MAX_EVENTS = 500;
const MAX_LOGS = 1000;

/**
 * Single source of truth for the whole dashboard. Does the initial REST snapshot,
 * then keeps it live from the WebSocket: high-volume streams (tokens, logs) are
 * applied directly for zero-latency UX, while anything that mutates a DB row
 * triggers a debounced refetch so derived data (metrics, manager briefs) stays exact.
 */
export function useDashboardStore({ onUnauthorized } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [events, setEvents] = useState([]);
  // The run in flight, tracked incrementally (see the event handler) rather than folded from the
  // bounded event log, which forgets `iteration.started` long before a run ends.
  const [activeRun, setActiveRun] = useState(null);
  const [logs, setLogs] = useState([]);
  const [thoughts, setThoughts] = useState({});
  const [wsStatus, setWsStatus] = useState('offline');
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    try {
      const s = await api.state();
      setSnapshot(s);
      setEvents(s.events || []);
      setLogs(s.logs || []);
      setError(null);
    } catch (e) {
      if (e.status === 401) return onUnauthorized?.();
      setError(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Coalesce refetches so an agent emitting a burst doesn't hammer the API.
  const pending = useRef(null);
  const refetchSoon = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      refetch();
    }, 300);
  }, [refetch]);

  useEffect(() => {
    let wasOffline = false;
    const onStatus = (status) => {
      setWsStatus(status);
      // On (re)connect, pull a fresh snapshot: while the socket was down we missed
      // every event, so the cached view is stale until we resync once.
      if (status === 'online' && wasOffline) refetch();
      wasOffline = status !== 'online';
    };
    return connectEvents((evt) => {
      /**
       * CURRENT-RUN STATE, tracked here rather than derived from the event log.
       *
       * The log is a bounded tail (`MAX_EVENTS`), and a single chatty type — `manager.brief` runs at
       * roughly 170/minute — fills it in under three minutes. A run takes longer than that, so
       * `iteration.started` is evicted while the run is still going and anything folding the log
       * concludes there is no run: every later phase event then looks orphaned. Run state must not
       * be a function of a buffer that forgets. Updated incrementally here, where each event is seen
       * exactly once and nothing is ever evicted.
       */
      if (evt.type === 'iteration.started') {
        setActiveRun({ id: evt.iterationId, trigger: evt.trigger, phase: null, summary: null, startedAt: Date.now(), phaseAt: Date.now() });
      } else if (evt.type === 'iteration.finished') {
        setActiveRun(null);
      } else if (evt.type === 'iteration.phase') {
        setActiveRun((r) => {
          // A phase event with no known run means this client connected mid-run: adopt it rather
          // than discard it, or the strip sits on "starting" while the run visibly progresses.
          const base = r || { id: evt.iterationId ?? null, startedAt: Date.now(), phase: null, summary: null, phaseAt: Date.now() };
          if (evt.status === 'running') return { ...base, phase: evt.phase, summary: null, phaseAt: Date.now() };
          if (evt.phase === base.phase) return { ...base, summary: evt.summary || base.summary };
          return base;
        });
      }

      // Control-plane heartbeat / hello: patch the control slice. One loop, one shape.
      if (evt.type === 'state' || evt.type === 'hello') {
        setSnapshot((s) => (s ? { ...s, control: evt.state, orchestrator: evt.state } : s));
        return;
      }

      // Live reasoning trace — kept out of the event log, tail only.
      if (evt.type === 'agent.token') {
        if (evt.kind !== 'thinking') return;
        setThoughts((t) => ({ ...t, [evt.agentId]: ((t[evt.agentId] || '') + evt.text).slice(-280) }));
        return;
      }
      if (evt.type === 'agent.started') setThoughts((t) => ({ ...t, [evt.agentId]: '' }));

      // Structured logs stream.
      if (evt.type === 'log') {
        setLogs((l) => [...l, evt].slice(-MAX_LOGS));
        return;
      }

      // Implementer token stream → live thought on the running iteration.
      if (evt.type === 'impl.token') {
        if (evt.kind !== 'thinking') return;
        setThoughts((t) => ({ ...t, __iteration: ((t.__iteration || '') + evt.text).slice(-280) }));
        return;
      }
      if (evt.type === 'iteration.started') setThoughts((t) => ({ ...t, __iteration: '' }));

      // Everything else is a semantic event for the activity feed.
      setEvents((prev) => [...prev, evt].slice(-MAX_EVENTS));

      if (
        evt.type.startsWith('proposal.') ||
        evt.type.startsWith('verify.') ||
        evt.type.startsWith('manager.') ||
        evt.type.startsWith('iteration.') ||
        evt.type === 'agent.finished' ||
        evt.type === 'config.changed'
      ) {
        refetchSoon();
      }
    }, onStatus);
  }, [refetchSoon, refetch]);

  // Action wrapper: run, then refetch so the UI reflects the result immediately.
  const act = useCallback(
    async (fn) => {
      try {
        const r = await fn();
        await refetch();
        return r;
      } catch (e) {
        if (e.status === 401) onUnauthorized?.();
        setError(e.message);
        throw e;
      }
    },
    [refetch],
  );

  const actions = {
    refetch,
    updateAgent: (id, patch) => act(() => api.updateAgent(id, patch)),
    runAgent: (id, instruction) => act(() => api.runAgent(id, instruction)),
    approve: (id, note) => act(() => api.approve(id, note)),
    reject: (id, reason) => act(() => api.reject(id, reason)),
    reverify: (id) => act(() => api.reverify(id)),

    // The one control plane. `startLoop`/`stopLoop` are kept as names because that
    // is what the operator calls them — they just no longer drive a second engine.
    startLoop: () => act(api.controlStart),
    stopLoop: () => act(api.controlStop),
    restartLoop: () => act(api.controlRestartLoop),
    /*
     * Deliberatamente FUORI da `act`. Quel wrapper fa un refetch subito dopo l'azione per mostrare
     * il risultato aggiornato, ma qui il risultato è che il server non c'è più: il refetch
     * fallirebbe e la dashboard mostrerebbe un errore di connessione al posto della conferma che
     * lo spegnimento è riuscito. Chi chiama gestisce lo stato terminale.
     */
    shutdown: () => api.controlShutdown(),
    cancelCurrent: () => act(api.controlCancel),
    runIteration: () => act(api.controlRun),
    restartIteration: (id) => act(() => api.controlRestart(id)),
    setControl: (body) => act(() => api.controlConfig(body)),

    settings: (body) => act(() => api.settings(body)),
    setKpi: (body) => act(() => api.setKpi(body)),
    readNotifications: () => act(api.readNotifications),
    promote: (upTo) => act(() => api.promote(upTo)),
  };

  return {
    ready: !!snapshot,
    error,
    setError,
    wsStatus,
    events,
    activeRun,
    logs,
    thoughts,
    control: snapshot?.control,
    orchestrator: snapshot?.control, // legacy alias — same object, one loop
    agents: snapshot?.agents || [],
    proposals: snapshot?.proposals || [],
    runs: snapshot?.runs || [],
    metrics: snapshot?.metrics,
    managers: snapshot?.managers || { briefs: [], messages: [] },
    iteration: snapshot?.iteration,
    notifications: snapshot?.notifications || { list: [], unread: 0 },
    deploy: snapshot?.deploy,
    plans: snapshot?.plans || { list: [], byCriticality: {} },
    repo: snapshot?.repo,
    codeStats: snapshot?.codeStats || null,
    actions,
  };
}
