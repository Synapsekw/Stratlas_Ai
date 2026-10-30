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
    const one = volumes({ movers: [{ label: 'North pile', changeM3: 60, change: '60 m³' }] });
    expect(surveySentences(facts({ volumes: one }))[1]).toBe(
      'The largest move was North pile, up 60 m³.',
    );
    const two = volumes({
      movers: [
        { label: 'Sand', changeM3: -70, change: '70 m³' },
        { label: 'North pile', changeM3: 60, change: '60 m³' },
      ],
    });
    expect(surveySentences(facts({ volumes: two }))[1]).toBe(
      'The largest moves were Sand, down 70 m³ and North pile, up 60 m³.',
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

  it('names the surveys on hold, else says they passed', () => {
    const held = facts({
      qa: { held: [{ label: 'Feb', date: '2026-02-28' }], passed: 1, released: 0, unchecked: 0 },
    });
    expect(surveySentences(held)).toEqual([
      'The survey of 28 Feb 2026 is on hold after its quality check; check it before relying on its figures.',
    ]);
    const two = facts({
      qa: {
        held: [
          { label: 'Jan', date: '2026-01-31' },
          { label: 'Feb', date: '2026-02-28' },
        ],
        passed: 0,
        released: 0,
        unchecked: 0,
      },
    });
    expect(surveySentences(two)[0]).toMatch(
      /^The surveys of 31 Jan 2026 and 28 Feb 2026 are on hold/,
    );
    expect(
      surveySentences(facts({ qa: { held: [], passed: 2, released: 0, unchecked: 0 } })),
    ).toEqual(['All 2 checked surveys passed their quality check.']);
    // a measure without a verdict says nothing either way
    expect(
      surveySentences(facts({ qa: { held: [], passed: 1, released: 0, unchecked: 1 } })),
    ).toEqual([]);
  });
});

describe('templateNarrative', () => {
  it('writes a full narrative offline for a volumetric project', () => {
    const n = templateNarrative(
      facts({
        volumes: volumes({ movers: [{ label: 'Sand', changeM3: -70, change: '70 m³' }] }),
        qa: { held: [{ label: 'Feb', date: '2026-02-28' }], passed: 0, released: 0, unchecked: 0 },
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
