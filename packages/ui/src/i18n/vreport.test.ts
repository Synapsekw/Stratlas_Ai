import { describe, expect, it } from 'vitest';
import { enVreport } from './en/vreport';
import { t } from './index';

const catalogue: Record<string, string> = enVreport;

const placeholders = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ''))].sort();

describe('volumetric report words for the rebuilt layout', () => {
  it('has every new key with its placeholders', () => {
    const want: Record<string, string[]> = {
      'vreport.band.pilesMeasured_one': ['count', 'measured'],
      'vreport.band.pilesMeasured_other': ['count', 'measured'],
      'vreport.notComputed': [],
      'vreport.pile.baseNotSet': [],
      'vreport.pile.belowBase': [],
      'vreport.overlap.warning': ['a', 'b'],
      'vreport.overlap.warningMany': ['pairs'],
      'vreport.overlap.pair': ['a', 'b'],
      'vreport.overview.title': [],
      'vreport.overview.photo': ['date'],
      'vreport.overview.elevation': ['date'],
      'vreport.overview.3d': ['date'],
      'vreport.card.photo': ['date'],
      'vreport.card.3d': ['date'],
      'vreport.card.before': ['date'],
      'vreport.card.since': ['date'],
      'vreport.card.profile': [],
      'vreport.card.profile.surface': ['date'],
      'vreport.card.profile.base': [],
      'vreport.card.profile.boundary': [],
      'vreport.card.profile.none': [],
      'vreport.card.footprint': [],
      'vreport.card.base': [],
      'vreport.card.baseLevel': [],
      'vreport.card.peak': [],
      'vreport.card.density': [],
      'vreport.card.surveyed': [],
      'vreport.card.no3d': ['count'],
      'vreport.pages.piles': [],
      'vreport.pictures.progressSite': ['date'],
      'vreport.pictures.progressPile': ['n', 'pile', 'total'],
      'vreport.pictures.progressChange': [],
      'vreport.pictures.progressCount': ['done', 'total'],
      'vreport.pictures.progressWritingPdf': [],
      'vreport.pictures.progressWritingHtml': [],
      'vreport.pictures.takeNow': [],
      'vreport.pictures.none': [],
      'vreport.error.noPictures': [],
    };
    for (const [k, p] of Object.entries(want)) {
      const v = catalogue[k] ?? '';
      expect(v, k).toBeTruthy();
      expect(placeholders(v), k).toEqual(p);
    }
  });

  it('holds no em or en dash, and no minus sign in front of a number', () => {
    for (const [k, v] of Object.entries(catalogue)) expect(v, k).not.toMatch(/[–—]|-\d|−/);
  });

  it('never makes taking pictures a required step', () => {
    // the two button labels stay until the editor stops using them; no sentence asks for the step
    const labels = new Set(['vreport.pictures.take', 'vreport.pictures.retake']);
    for (const [k, v] of Object.entries(catalogue))
      if (!labels.has(k)) expect(v, k).not.toMatch(/take pictures/i);
    expect(catalogue['vreport.pictures.none']).toBe('Pictures are taken when you export.');
    expect(catalogue['vreport.pictures.takeNow']).toBe('Take them now');
  });

  it('reads as the approved layout', () => {
    expect(t('vreport.band.pilesMeasured', { count: 8, measured: 3 })).toBe('8 piles, 3 measured');
    expect(t('vreport.band.pilesMeasured', { count: 1, measured: 0 })).toBe('1 pile, 0 measured');
    expect(t('vreport.notComputed')).toBe('Not computed');
    expect(t('vreport.pile.baseNotSet')).toBe('Not set');
    expect(t('vreport.pile.belowBase')).toBe('The surface is below the base here. Check the base.');
    expect(t('vreport.pages.piles')).toBe('B. Site overview and pile pages');
    expect(t('vreport.overlap.warning', { a: '2 Pile B', b: '5 Pile E' })).toBe(
      '2 Pile B and 5 Pile E overlap, so the site total may count the same material twice.',
    );
    expect(t('vreport.pictures.progressSite', { date: '12 Mar 2026' })).toBe('Site, 12 Mar 2026');
    expect(t('vreport.pictures.progressPile', { n: 4, total: 31, pile: 'Pile D' })).toBe(
      'Pile 4 of 31: Pile D',
    );
    expect(t('vreport.pictures.progressCount', { done: 12, total: 97 })).toBe('Picture 12 of 97');
    expect(t('vreport.pictures.progressWritingPdf')).toBe('Writing the PDF');
    expect(t('vreport.pictures.progressWritingHtml')).toBe('Writing the HTML file');
    expect(t('vreport.card.no3d', { count: 168 })).toBe(
      'No 3D picture: the report pictures the 168 largest piles',
    );
  });
});
