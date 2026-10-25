import { volumetricModel, type VolumetricInput, type VolumetricT } from '@aio/project/export';
import { ReportTextFile } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  editPileNote,
  editText,
  emptyReportText,
  generatedTexts,
  pagesOf,
  pileNotesOf,
  PILE_NOTE_MAX,
  previewModel,
  recordGenerated,
  resetText,
  resolveTexts,
  setCompareWith,
  setPage,
} from './editorModel';

const t: VolumetricT = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;
const at = (s: string) => new Date(`2026-10-25T${s}:00Z`);

const pileDate = (capture: string, volumeM3: number) => ({
  capture,
  volumeM3,
  densityTPerM3: 1.6,
  areaM2: 100,
  peakM: 4,
  plusMinusM3: null,
  outline: [
    [0, 0],
    [10, 0],
    [10, 10],
  ] as [number, number][],
});

const input = (): VolumetricInput => ({
  captures: [
    { id: 'c1', label: 'May', date: '2026-05-01' },
    { id: 'c2', label: 'June', date: '2026-06-01' },
  ],
  piles: [
    {
      id: 'm1',
      label: 'SP1',
      material: null,
      base: 'Lowest point',
      dates: [pileDate('c1', 1000), pileDate('c2', 1200)],
    },
  ],
  project: { name: 'Demo yard', customer: 'Yard owner', site: null, crs: 'EPSG:32639' },
  method: { cellM: 0.1, gsdCm: 3, siteDensityTPerM3: null },
  frame: null,
});

const ctx = {
  title: 'Stockpile volume report',
  customer: 'Yard owner',
  companyName: 'Survey firm',
  t,
};

describe('generated texts', () => {
  it('fills title, Prepared for, Prepared by, summary and method from the figures', () => {
    const model = volumetricModel(input());
    const g = generatedTexts(model, ctx);
    expect(g.title).toBe('Stockpile volume report');
    expect(g.preparedFor).toBe('Yard owner');
    expect(g.preparedBy).toBe('Survey firm');
    expect(g.summary).toContain('vreport.short');
    expect(g.method).toContain('vreport.method.base');
    expect(g.intro).toBe('');
    expect(g.closing).toBe('');
  });

  it('leaves Prepared for and Prepared by empty without a customer or company name', () => {
    const g = generatedTexts(volumetricModel(input()), {
      ...ctx,
      customer: null,
      companyName: '  ',
    });
    expect(g.preparedFor).toBe('');
    expect(g.preparedBy).toBe('');
  });
});

describe('resolved texts', () => {
  const g = generatedTexts(volumetricModel(input()), ctx);

  it('uses the generated text when nothing is saved', () => {
    const r = resolveTexts(null, g);
    expect(r.summary).toEqual({ text: g.summary, generated: true });
    expect(r.intro).toEqual({ text: '', generated: true });
  });

  it('keeps a user version and follows the figures for a template one', () => {
    let f = editText(null, 'summary', 'Edited summary.', {}, at('10:00'));
    f = resetText(f, 'method', 'old generated method', at('10:01'));
    const r = resolveTexts(f, g);
    expect(r.summary).toEqual({ text: 'Edited summary.', generated: false });
    expect(r.method).toEqual({ text: g.method, generated: true });
  });
});

describe('editing', () => {
  it('saves an edit as a user version with its author and time', () => {
    const f = editText(null, 'title', 'Monthly yard report', { author: 'Surveyor' }, at('10:00'));
    expect(ReportTextFile.parse(f)).toBeTruthy();
    expect(f.report).toBe('volumetric');
    expect(f.parts.title?.versions).toEqual([
      {
        text: 'Monthly yard report',
        source: 'user',
        author: 'Surveyor',
        createdAt: '2026-10-25T10:00:00.000Z',
      },
    ]);
  });

  it('Reset adds a template version and keeps the history', () => {
    let f = editText(null, 'summary', 'Mine.', {}, at('10:00'));
    f = resetText(f, 'summary', 'Generated.', at('10:01'));
    expect(f.parts.summary?.versions.map((v) => [v.source, v.text])).toEqual([
      ['user', 'Mine.'],
      ['template', 'Generated.'],
    ]);
  });

  it('records the latest generated text of template parts, and leaves user parts alone', () => {
    let f = resetText(null, 'summary', 'Old figures.', at('10:00'));
    f = editText(f, 'title', 'Mine', {}, at('10:00'));
    const g = { ...generatedTexts(volumetricModel(input()), ctx), summary: 'New figures.' };
    const next = recordGenerated(f, g, at('11:00'));
    expect(next.parts.summary?.versions.at(-1)).toMatchObject({
      source: 'template',
      text: 'New figures.',
    });
    expect(next.parts.title?.versions).toHaveLength(1);
    expect(recordGenerated(next, g, at('12:00'))).toBe(next);
  });
});

describe('pile notes', () => {
  it('caps a note at 280 characters', () => {
    const f = editPileNote(null, 'm1', 'x'.repeat(400), {}, at('10:00'));
    expect(pileNotesOf(f).m1).toHaveLength(PILE_NOTE_MAX);
    expect(PILE_NOTE_MAX).toBe(280);
  });

  it('drops an emptied note from the notes the report prints', () => {
    let f = editPileNote(null, 'm1', 'Reclaimed on the east side.', {}, at('10:00'));
    expect(pileNotesOf(f)).toEqual({ m1: 'Reclaimed on the east side.' });
    f = editPileNote(f, 'm1', '  ', {}, at('10:01'));
    expect(pileNotesOf(f)).toEqual({});
  });
});

describe('pages', () => {
  it('has every page on by default', () => {
    expect(pagesOf(null)).toEqual({ cover: true, piles: true, change: true });
  });

  it('turns pages off but keeps at least one on', () => {
    let f = setPage(null, 'cover', false);
    f = setPage(f, 'piles', false);
    expect(pagesOf(f)).toEqual({ cover: false, piles: false, change: true });
    const same = setPage(f, 'change', false);
    expect(same).toBe(f);
    expect(pagesOf(setPage(f, 'cover', true)).cover).toBe(true);
  });
});

describe('compare with and the preview model', () => {
  it('stores and clears the compared date', () => {
    const f = setCompareWith(null, 'c1');
    expect(f.compareWith).toBe('c1');
    expect(setCompareWith(f, null).compareWith).toBeUndefined();
  });

  it('puts the resolved texts, pile notes and pages on the model', () => {
    const model = volumetricModel(input());
    let f = editText(emptyReportText(), 'summary', 'Edited.', {}, at('10:00'));
    f = editPileNote(f, 'm1', 'East side.', {}, at('10:00'));
    f = setPage(f, 'change', false);
    const p = previewModel(model, resolveTexts(f, generatedTexts(model, ctx)), f);
    expect(p.text.summary).toBe('Edited.');
    expect(p.text.preparedFor).toBe('Yard owner');
    expect(p.piles[0]?.note).toBe('East side.');
    expect(p.pages).toEqual({ cover: true, piles: true, change: false });
    expect(model.piles[0]?.note).toBeNull();
  });
});
