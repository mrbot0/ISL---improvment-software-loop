import { useEffect, useState } from 'react';

/**
 * Minimal internationalisation (ISL_Frontend §9). A dictionary + a `t(key)` lookup, a
 * persisted current locale, and a `useLocale` hook that re-renders subscribers when the
 * language changes. Start with English + Italian (the operator works in Italian); adding a
 * locale is just another object. Keys fall back to English, then to the key itself, so a
 * missing translation degrades gracefully instead of blanking the UI.
 */
const DICT = {
  en: {
    'nav.Workspace': 'Workspace', 'nav.Improve': 'Improve', 'nav.Fleet': 'Fleet',
    'nav.Deploy': 'Deploy', 'nav.Insight': 'Insight', 'nav.Administration': 'Administration',
    'action.skipToContent': 'Skip to content', 'action.signOut': 'Sign out',
    'action.toggleTheme': 'Toggle theme', 'action.toggleMenu': 'Toggle menu',
    'status.online': 'online', 'status.offline': 'offline',
    'resource.failed': 'Could not load this', 'resource.retry': 'try again',
    'lang.name': 'English',
  },
  it: {
    'nav.Workspace': 'Spazio di lavoro', 'nav.Improve': 'Migliora', 'nav.Fleet': 'Flotta',
    'nav.Deploy': 'Rilascio', 'nav.Insight': 'Analisi', 'nav.Administration': 'Amministrazione',
    'action.skipToContent': 'Vai al contenuto', 'action.signOut': 'Esci',
    'action.toggleTheme': 'Cambia tema', 'action.toggleMenu': 'Apri/chiudi menu',
    'status.online': 'online', 'status.offline': 'offline',
    'resource.failed': 'Impossibile caricare', 'resource.retry': 'riprova',
    'lang.name': 'Italiano',
  },
};

export const LOCALES = Object.keys(DICT);

let _locale = (() => {
  try {
    const saved = localStorage.getItem('isl.locale');
    if (saved && DICT[saved]) return saved;
    const nav = (navigator.language || 'en').slice(0, 2);
    return DICT[nav] ? nav : 'en';
  } catch {
    return 'en';
  }
})();

const _listeners = new Set();

/** Translate a key for the current locale (falls back to English, then the key). */
export function t(key, vars) {
  let s = DICT[_locale]?.[key] ?? DICT.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

export function getLocale() {
  return _locale;
}

export function setLocale(locale) {
  if (!DICT[locale] || locale === _locale) return;
  _locale = locale;
  try {
    localStorage.setItem('isl.locale', locale);
    document.documentElement.setAttribute('lang', locale);
  } catch {
    /* ignore */
  }
  _listeners.forEach((fn) => fn(locale));
}

/** Subscribe a component to locale changes. Returns [locale, setLocale]. */
export function useLocale() {
  const [locale, set] = useState(_locale);
  useEffect(() => {
    const fn = (l) => set(l);
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }, []);
  return [locale, setLocale];
}
