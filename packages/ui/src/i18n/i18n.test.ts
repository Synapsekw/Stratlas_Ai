import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import {
  catalogueProblems,
  directionOf,
  getLocale,
  placeholders,
  setLocale,
  t,
  type Catalogue,
} from './index';

afterEach(() => {
  setLocale('en');
});

describe('t', () => {
  it('returns the English string for a key', () => {
    expect(t('nav.projects')).toBe('Projects');
  });

  it('fills placeholders', () => {
    expect(t('settings.maps.installed', { count: 3, size: '1.3 GB' })).toBe('3 · 1.3 GB');
  });

  it('picks the plural form from the count', () => {
    expect(t('library.count', { count: 1 })).toBe('1 project');
    expect(t('library.count', { count: 6 })).toBe('6 projects');
  });

  it('falls back to English for keys a locale does not have yet', () => {
    const ar: Catalogue = { 'nav.projects': 'المشاريع' };
    setLocale('ar', ar);
    expect(getLocale()).toBe('ar');
    expect(t('nav.projects')).toBe('المشاريع');
    expect(t('nav.issues')).toBe('Issues');
  });
});

describe('directionOf', () => {
  it('knows the right-to-left scripts', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ar-KW')).toBe('rtl');
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('fr-FR')).toBe('ltr');
  });
});

describe('the English catalogue', () => {
  it('has no problems', () => {
    expect(catalogueProblems(en, en)).toEqual([]);
  });

  it('uses no em or en dashes (CONTRIBUTING)', () => {
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toMatch(/[–—]/);
  });

  it('finds missing keys and placeholder mismatches in a translation', () => {
    expect(placeholders('{count} of {total}')).toEqual(['count', 'total']);
    const bad: Catalogue = { 'library.count_one': '{n} مشروع', 'nope.key': 'x' };
    const problems = catalogueProblems(bad, en);
    expect(problems).toContain('library.count_one: placeholders {n} do not match {count}');
    expect(problems).toContain('nope.key: not in the English catalogue');
  });
});
