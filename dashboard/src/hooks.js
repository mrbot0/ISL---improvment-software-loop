import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * Authentication gate. Resolves the current user from the session cookie on
 * mount; exposes login/logout and a refresh so the app can react to a 401 the
 * WebSocket or a REST call surfaces.
 */
export function useAuth() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    const r = await api.login(email, password);
    setUser(r.user);
    return r;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setUser(null);
  }, []);

  return { user, ready, refresh, login, logout, setUser };
}

/** Persisted state, synced to localStorage. */
export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / private mode */
    }
  }, [key, value]);
  return [value, setValue];
}

/**
 * Hash-based route (`#/view`). Deep-linkable, refresh-safe, back/forward works.
 * Returns [view, setView].
 */
export function useHashRoute(fallback) {
  const read = () => (location.hash.replace(/^#\/?/, '') || fallback);
  const [view, setViewState] = useState(read);
  useEffect(() => {
    const onHash = () => setViewState(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setView = useCallback((v) => {
    if (v !== read()) location.hash = `/${v}`;
    setViewState(v);
  }, []);
  return [view, setView];
}

/** Apply a theme to <html> and persist it. */
export function useTheme() {
  const [theme, setTheme] = useLocalStorage('isl.theme', 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [setTheme]);
  return [theme, toggle, setTheme];
}

/**
 * SERVER-PERSISTED PREFERENCES.
 *
 * Theme, density and locale were per BROWSER: a second machine or a cleared cache lost them. This
 * makes the server the source of truth while keeping localStorage as the *cache*, which is not
 * redundancy — reading the server first would repaint the page after load, so the operator would
 * watch their own theme flip on every visit. Local applies instantly; the server corrects it once,
 * if it disagrees.
 *
 * Writes are best-effort: a preference that fails to save is a nuisance, not an error worth putting
 * in front of someone, and the local value still applies.
 *
 * @param {object|null} user     the signed-in user, or null
 * @param {object} setters       { setTheme, setDensity, setLocale } — applied when the server differs
 */
export function usePreferences(user, setters = {}) {
  const [prefs, setPrefs] = useState(null);
  const applied = useRef(false);

  useEffect(() => {
    if (!user || applied.current) return;
    let cancelled = false;
    api.preferences()
      .then((r) => {
        if (cancelled || !r?.prefs) return;
        applied.current = true;
        setPrefs(r.prefs);
        // Apply only what the server actually holds: an unset preference must not overwrite a local
        // choice with a default the user never made.
        if (r.prefs.theme && setters.setTheme) setters.setTheme(r.prefs.theme);
        if (r.prefs.density && setters.setDensity) setters.setDensity(r.prefs.density);
        if (r.prefs.locale && setters.setLocale) setters.setLocale(r.prefs.locale);
      })
      .catch(() => { /* unauthenticated or offline — local values stand */ });
    return () => { cancelled = true; };
  }, [user?.id]);

  const save = useCallback((patch) => {
    setPrefs((p) => ({ ...(p || {}), ...patch }));
    api.savePreferences(patch).catch(() => { /* best-effort: the local value still applies */ });
  }, []);

  return [prefs, save];
}

/**
 * Information density. An operator on a 27" monitor watching a fleet wants more rows per screen
 * than someone on a laptop; `compact` tightens padding and type via `[data-density]` in the CSS
 * rather than by re-laying-out every view. Persisted per browser.
 */
export function useDensity() {
  const [density, setDensity] = useLocalStorage('isl.density', 'comfortable');
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);
  const toggle = useCallback(() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact')), [setDensity]);
  return [density, toggle, setDensity];
}

/**
 * Global keyboard shortcuts. `map` is { 'key': handler }. Modifier combos use
 * 'mod+k' (mod = ctrl or cmd). Ignores typing in inputs/textareas except for
 * combos with a modifier.
 */
export function useKeyboard(map, deps = []) {
  useEffect(() => {
    const onKey = (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      const combo = `${mod ? 'mod+' : ''}${e.key.toLowerCase()}`;
      if (map[combo]) {
        if (mod || !inField) {
          e.preventDefault();
          map[combo](e);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * useResource — a tiny SWR-style data hook (ISL_Frontend §4).
 *
 * Replaces the per-view "fetch + useState + setInterval" pattern with a shared cache:
 *   - paints instantly from cache when you revisit a view (no spinner flicker),
 *   - dedups concurrent requests for the same key,
 *   - refetches in the background (optionally on an interval),
 *   - exposes { data, loading, error, refetch }.
 *
 * `key` is any stable string; `fetcher` returns a promise. Pass { interval } to poll.
 */
const _cache = new Map(); // key -> { data, ts }
const _inflight = new Map(); // key -> promise
const _subs = new Map(); // key -> Set<refetch fn>  (for live invalidation)

export function useResource(key, fetcher, { interval = 0, enabled = true } = {}) {
  const [, force] = useState(0);
  const cached = _cache.get(key);
  const stateRef = useRef({ data: cached?.data ?? null, loading: !cached, error: null });

  const run = useCallback(() => {
    if (!enabled) return;
    let p = _inflight.get(key);
    if (!p) {
      p = Promise.resolve()
        .then(fetcher)
        .then((data) => { _cache.set(key, { data, ts: Date.now() }); return data; })
        .finally(() => _inflight.delete(key));
      _inflight.set(key, p);
    }
    p.then((data) => { stateRef.current = { data, loading: false, error: null }; force((n) => n + 1); })
      .catch((error) => { stateRef.current = { ...stateRef.current, loading: false, error }; force((n) => n + 1); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled) return;
    // Instant paint from cache, then refresh.
    const c = _cache.get(key);
    stateRef.current = { data: c?.data ?? null, loading: !c, error: null };
    run();
    // Subscribe so a WS-driven invalidateResource(key) refetches this mounted view live.
    if (!_subs.has(key)) _subs.set(key, new Set());
    _subs.get(key).add(run);
    const t = interval ? setInterval(run, interval) : null;
    return () => {
      if (t) clearInterval(t);
      _subs.get(key)?.delete(run);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval, enabled]);

  return { ...stateRef.current, refetch: run };
}

/**
 * Drop a cached resource and tell any mounted view using it to refetch NOW. Keys can be
 * exact ('decisions') or a prefix wildcard ('runs:*'). Wire this to WebSocket events so the
 * UI updates the instant something changes, instead of waiting for the next poll.
 */
export function invalidateResource(key) {
  const wildcard = key.endsWith('*') ? key.slice(0, -1) : null;
  for (const k of [..._cache.keys(), ..._subs.keys()]) {
    if (wildcard ? k.startsWith(wildcard) : k === key) {
      _cache.delete(k);
      _subs.get(k)?.forEach((fn) => fn());
    }
  }
}
