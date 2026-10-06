import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLocale, getLocale, LOCALES } from './i18n.js';

describe('i18n', () => {
  beforeEach(() => setLocale('en'));
  it('translates a known key per locale', () => {
    expect(t('nav.Fleet')).toBe('Fleet');
    setLocale('it');
    expect(t('nav.Fleet')).toBe('Flotta');
  });
  it('falls back to the key when missing', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });
  it('exposes en + it locales and tracks the current one', () => {
    expect(LOCALES).toEqual(expect.arrayContaining(['en', 'it']));
    setLocale('it');
    expect(getLocale()).toBe('it');
  });
});
