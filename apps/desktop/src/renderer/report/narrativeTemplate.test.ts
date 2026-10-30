import type { NarrativeFacts } from '@aio/project/export';
import { describe, expect, it } from 'vitest';
import { surveySentences, templateNarrative } from './narrativeTemplate';

const facts = (patch: Partial<NarrativeFacts> = {}): NarrativeFacts => ({
  project: 'Quarry',
  customer: '',
  site: '',
  kind: 'volumetric',
  captures: [
    { label: 'Jan', date: '2026-01-31' },
    { label: 'Feb', date: '2026-02-28' },
  ],
  data: {
    photos: 0,
    panoramas: 0,
    videos: 0,
    meshes: 0,
    clouds: 2,
    points: 0,
    rasters: 2,
    vectors: 0,
  } as NarrativeFacts['data'],
  issues: {
    total: 0,
    placed: 0,
    withPhoto: 0,
    uncertain: 0,
    bySeverity: [],
    byClass: [],
    byZone: [],
    byStatus: [],
    worst: [],
  },
  severityScale: [],
  volumes: null,
  road: null,
  qa: null,
  ...patch,
});

type V = NonNullable<NarrativeFacts['volumes']>;
const volumes = (patch: Partial<V> = {}): V => ({
  base: 'Triangulated toe',
  captures: ['2026-01-31', '2026-02-28'],
  piles: 3,
  totalsM3: [1000, 1100],
  changeM3: 100,
  total: '1,100 m³',
  change: '100 m³',
  since: '2026-01-31',
  date: '2026-02-28',
  movers: [],
  notCounted: 0,
  ...patch,
});

describe('the survey sentences of the narrative', () => {
  it('says nothing about piles with none, or without volumes', () => {
    expect(surveySentences(facts())).toEqual([]);
    expect(surveySentences(facts({ volumes: volumes({ piles: 0 }) }))).toEqual([]);
  });

  it('counts one pile and several piles', () => {
    expect(surveySentences(facts({ volumes: volumes({ piles: 1 }) }))).toEqual([
      'One stockpile is measured.',
    ]);
    expect(surveySentences(facts({ volumes: volumes() }))).toEqual(['3 stockpiles are measured.']);
  });

  it('names the piles that moved most, up and down', () => {
    const one = volumes({
      movers: [{ label: 'North pile', changeM3: 60, up: true, change: '60 m³' }],
    });
    expect(surveySentences(facts({ volumes: one }))[1]).toBe(
      'The largest move was North pile, up 60 m³.',
    );
    const two = volumes({
      movers: [
        { label: 'Sand', changeM3: -70, up: false, change: '70 m³' },
        { label: 'North pile', changeM3: 60, up: true, change: '60 m³' },
      ],
    });
    expect(surveySentences(facts({ volumes: two }))[1]).toBe(
      'The largest moves were Sand, down 70 m³ and North pile, up 60 m³.',
    );
  });

  it('takes the direction from the facts, not from a rounded figure (tiny movers)', () => {
    const tiny = volumes({
      movers: [{ label: 'Gravel', changeM3: -1, up: false, change: '0.6 m³' }],
    });
    expect(surveySentences(facts({ volumes: tiny }))[1]).toBe(
      'The largest move was Gravel, down 0.6 m³.',
    );
  });

  it('says which piles are left out of the total (missing data)', () => {
    expect(surveySentences(facts({ volumes: volumes({ notCounted: 2 }) }))).toContain(
      '2 stockpiles have no figure on the survey of 28 Feb 2026 and are left out of the total.',
    );
    expect(surveySentences(facts({ volumes: volumes({ notCounted: 1 }) }))).toContain(
      '1 stockpile has no figure on the survey of 28 Feb 2026 and is left out of the total.',
    );
  });

  const none = { held: [], passed: [], released: [], unchecked: 0 };
  const jan = { label: 'Jan', date: '2026-01-31' };
  const feb = { label: 'Feb', date: '2026-02-28' };

  it('names the surveys on hold, once per date', () => {
    expect(surveySentences(facts({ qa: { ...none, held: [feb] } }))).toEqual([
      'The survey of 28 Feb 2026 is on hold after its quality check; check it before relying on its figures.',
    ]);
    const two = surveySentences(facts({ qa: { ...none, held: [jan, feb, feb] } }));
    expect(two[0]).toMatch(/^The surveys of 31 Jan 2026 and 28 Feb 2026 are on hold/);
    // the same date twice is one survey
    expect(surveySentences(facts({ qa: { ...none, held: [feb, feb] } }))[0]).toMatch(
      /^The survey of 28 Feb 2026 is on hold/,
    );
  });

  it('names the surveys that passed and, apart, those a person released', () => {
    expect(surveySentences(facts({ qa: { ...none, passed: [feb] } }))).toEqual([
      'The survey of 28 Feb 2026 passed its quality check.',
    ]);
    expect(surveySentences(facts({ qa: { ...none, passed: [jan, feb] } }))).toEqual([
      'The surveys of 31 Jan 2026 and 28 Feb 2026 passed their quality check.',
    ]);
    expect(surveySentences(facts({ qa: { ...none, passed: [jan], released: [feb] } }))).toEqual([
      'The survey of 31 Jan 2026 passed its quality check.',
      'The survey of 28 Feb 2026 failed its quality check and was released by a person with a note.',
    ]);
  });

  it('says nothing either way when every check was measured without a verdict', () => {
    expect(surveySentences(facts({ qa: { ...none, unchecked: 2 } }))).toEqual([]);
  });
});

describe('templateNarrative', () => {
  it('writes a full narrative offline for a volumetric project', () => {
    const n = templateNarrative(
      facts({
        volumes: volumes({
          movers: [{ label: 'Sand', changeM3: -70, up: false, change: '70 m³' }],
        }),
        qa: {
          held: [{ label: 'Feb', date: '2026-02-28' }],
          passed: [],
          released: [],
          unchecked: 0,
        },
      }),
      { todo: false },
    );
    expect(n.summary).toContain('Quarry was surveyed on 31 Jan 2026 and 28 Feb 2026.');
    expect(n.summary).toContain('a change of 100 m³ since the survey of 31 Jan 2026');
    expect(n.summary).toContain('3 stockpiles are measured.');
    expect(n.summary).toContain('The largest move was Sand, down 70 m³.');
    expect(n.summary).toContain('is on hold after its quality check');
    expect(n.method).toContain('compared with the survey before it');
    expect(n.findings).toBe('No issues were recorded.');
    for (const text of Object.values(n)) expect(text).not.toMatch(/[–—]|\[/);
  });

  it('says the surveys were not checked when there are piles and no QA', () => {
    const n = templateNarrative(facts({ volumes: volumes() }), { todo: false });
    expect(n.method).toContain('The surveys have not been quality checked in the app.');
  });

  it('says the checks gave no verdict when every one was measured without one', () => {
    const n = templateNarrative(
      facts({ volumes: volumes(), qa: { held: [], passed: [], released: [], unchecked: 2 } }),
      { todo: false },
    );
    expect(n.method).toContain('measured without a verdict, as the site has no quality level set');
    expect(n.method).not.toContain('at the site quality level');
  });

  it('copes with missing data: no dates, no data, no volumes', () => {
    const n = templateNarrative(
      facts({
        captures: [],
        data: { ...facts().data, clouds: 0, rasters: 0 },
        volumes: volumes({ date: '', total: '-', change: null, since: null }),
      }),
      { todo: false },
    );
    expect(n.summary).toContain('Quarry was surveyed.');
    expect(n.summary).not.toContain('held');
    expect(n.summary).not.toMatch(/ on \./);
    expect(n.method).not.toContain('captured on');
  });
});
