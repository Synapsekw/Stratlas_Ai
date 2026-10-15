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

  it('has the strings for adding a survey date', () => {
    const keys = [
      'change.surveyDateNew',
      'change.surveyDateNewDay',
      'change.surveyDateAdd',
      'change.surveyDateCancel',
      'change.surveyDateNewTag',
      'change.surveyDateFrom.photos',
      'change.surveyDateFrom.video',
      'change.surveyDateFrom.both',
      'tree.addDate',
      'tree.addDate.tip',
      'tree.addDate.date',
      'tree.addDate.name',
      'tree.addDate.namePlaceholder',
      'tree.addDate.submit',
      'tree.addDate.folder',
      'tree.addDate.folderHint',
      'tree.addDate.folderTitle',
      'tree.addDate.exists',
      'tree.addDate.invalid',
      'tree.datePrompt.existing',
      'tree.datePrompt.new',
      'tree.datePrompt.file',
      'tree.datePrompt.later',
      'palette.addSurveyDate',
      'palette.importFlightFolder',
    ];
    for (const k of keys) {
      const v = (en as Record<string, string>)[k];
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/—/);
    }
    expect(t('tree.datePrompt.title', { count: 1 })).toBe(
      '1 dataset in Every date was recorded on a survey day.',
    );
    expect(t('tree.datePrompt.title', { count: 3 })).toBe(
      '3 datasets in Every date were recorded on survey days.',
    );
    expect(t('tree.datePrompt.done', { count: 1 })).toBe('Filed 1 dataset.');
    expect(t('tree.datePrompt.done', { count: 4 })).toBe('Filed 4 datasets.');
    expect(t('tree.datePrompt.mixed', { count: 1 })).toBe(
      '1 dataset holds photos from several days. Move it by hand.',
    );
    expect(t('tree.datePrompt.mixed', { count: 2 })).toBe(
      '2 datasets hold photos from several days. Move them by hand.',
    );
    expect(en['change.surveyDateNew']).toBe('New survey date...');
  });

  it('has the strings for placing findings on a model', () => {
    expect(t('place.offer', { count: 2 })).toBe('Connect 2 findings to a model?');
    expect(t('place.offer', { count: 1 })).toBe('Connect 1 finding to a model?');
    expect(t('place.result', { placed: 12, count: 14, layer: 'Mesh 3 Mar' })).toBe(
      'Placed 12 of 14 on Mesh 3 Mar.',
    );
    expect(t('place.missed', { count: 2 })).toBe('2 missed the model.');
    expect(t('place.match', { code: 'AI-31', other: 'AI-12', date: '3 Mar' })).toBe(
      'AI-31 looks like AI-12 from 3 Mar',
    );
    expect(t('place.menu', { count: 1 })).toBe('Place on model...');
    expect(t('place.menu', { count: 3 })).toBe('Place 3 on model...');
    for (const [k, v] of Object.entries(en))
      if (k.startsWith('place.')) expect(v, k).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('finds missing keys and placeholder mismatches in a translation', () => {
    expect(placeholders('{count} of {total}')).toEqual(['count', 'total']);
    const bad: Catalogue = { 'library.count_one': '{n} مشروع', 'nope.key': 'x' };
    const problems = catalogueProblems(bad, en);
    expect(problems).toContain('library.count_one: placeholders {n} do not match {count}');
    expect(problems).toContain('nope.key: not in the English catalogue');
  });
});
