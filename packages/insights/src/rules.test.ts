import { describe, expect, it } from 'vitest';
import { figuresFromRows, siteInsights, type SiteSnapshot } from './rules';
import { CAPTURES, checkpoints, fig, qaFile, summary } from './testing';

/** A quiet site: three dates, both later ones passed with checkpoints, a steady pile. */
function site(patch: Partial<SiteSnapshot> = {}): SiteSnapshot {
  return {
    captures: CAPTURES,
    qa: {
      m2: qaFile('m2', { checkpoints: checkpoints(0.03) }),
      m3: qaFile('m3', { checkpoints: checkpoints(0.03) }),
    },
    qaLevel: 'moderate',
    rmseLimitM: 0.1,
    figures: [fig('a', { m1: 100, m2: 101, m3: 102 })],
    changes: [],
    staleChangeSets: [],
    today: '2026-09-02',
    ...patch,
  };
}

const rules = (s: SiteSnapshot) => siteInsights(s).map((i) => i.id);

describe('siteInsights', () => {
  it('has nothing to say on a quiet site, nor on a one-date project', () => {
    expect(siteInsights(site())).toEqual([]);
    expect(siteInsights(site({ captures: CAPTURES.slice(0, 1), qa: {}, figures: [] }))).toEqual([]);
  });

  it('survey-held: the latest held date, with the figures measured on it', () => {
    const s = site({ qa: { ...site().qa, m2: qaFile('m2', { status: 'hold' }) } });
    const [held] = siteInsights(s);
    expect(held).toMatchObject({
      id: 'survey-held:m2',
      severity: 'critical',
      text: { key: 'insights.held', params: { date: '2026-08-01', count: 1 } },
      actions: [{ id: 'insights.openQa', capture: 'm2' }],
    });
    expect(held?.evidence).toEqual([
      { kind: 'qa', capture: 'm2' },
      { kind: 'measurement', id: 'a' },
    ]);
  });

  it('survey-held-older: earlier unreleased holds are one note under the latest', () => {
    const captures = [...CAPTURES, { id: 'm4', date: '2026-10-01', label: 'October' }];
    const s = site({
      captures,
      qa: {
        m2: qaFile('m2', { status: 'hold' }),
        m3: qaFile('m3', { status: 'fail' }),
        m4: qaFile('m4', { status: 'hold' }),
      },
      figures: [],
    });
    const out = siteInsights(s);
    expect(out.map((i) => [i.id, i.severity])).toEqual([
      ['survey-held:m4', 'critical'],
      ['survey-held-older:m3', 'info'],
    ]);
    expect(out[1]).toMatchObject({
      text: { key: 'insights.heldEarlier', params: { count: 2 } },
      evidence: [
        { kind: 'qa', capture: 'm2' },
        { kind: 'qa', capture: 'm3' },
      ],
      actions: [{ id: 'insights.openQa', capture: 'm3' }],
    });
  });

  it('rmse-over: checkpoint RMSE over the site limit, as distances in metres', () => {
    const s = site({ qa: { ...site().qa, m2: qaFile('m2', { checkpoints: checkpoints(0.153) }) } });
    expect(siteInsights(s)).toEqual([
      expect.objectContaining({
        id: 'rmse-over:m2',
        severity: 'warning',
        text: {
          key: 'insights.rmseOver',
          params: { date: '2026-08-01', rmse: { distance: 0.153 }, limit: { distance: 0.1 } },
        },
      }),
    ]);
  });

  it('survey-unchecked: the latest date without a QA file, or without a verdict', () => {
    const none = site({ qa: { m2: qaFile('m2', { checkpoints: checkpoints(0.03) }) } });
    expect(siteInsights(none)).toEqual([
      expect.objectContaining({
        id: 'survey-unchecked:m3',
        severity: 'info',
        text: { key: 'insights.unchecked', params: { date: '2026-09-01' } },
        evidence: [{ kind: 'capture', id: 'm3' }],
        actions: [{ id: 'insights.openQa', capture: 'm3' }],
      }),
    ]);
    const off = site({
      qa: { ...site().qa, m3: qaFile('m3', { level: 'off', status: 'unchecked' }) },
    });
    expect(siteInsights(off)[0]?.text.key).toBe('insights.noVerdict');
    // an earlier date left unchecked is not news
    const { m3 } = site().qa;
    expect(rules(site({ qa: m3 ? { m3 } : {} }))).toEqual([]);
  });

  it('no-checkpoints: the latest date passed on the previous survey only', () => {
    const s = site({ qa: { ...site().qa, m3: qaFile('m3') } });
    expect(siteInsights(s)).toEqual([
      expect.objectContaining({
        id: 'no-checkpoints:m3',
        text: { key: 'insights.noCheckpoints', params: { date: '2026-09-01' } },
      }),
    ]);
  });

  it('change-stale: a change set out of date after a line-up', () => {
    const s = site({
      changes: [summary('m1', 'm2', { open: 0 })],
      staleChangeSets: ['m1-m2-issues'],
    });
    expect(siteInsights(s)).toEqual([
      expect.objectContaining({
        id: 'change-stale:m1>m2',
        severity: 'warning',
        text: { key: 'insights.changeStale', params: { from: '2026-07-01', to: '2026-08-01' } },
        evidence: [{ kind: 'changeSet', id: 'm1-m2-issues' }],
        actions: [{ id: 'insights.openChanges', pair: { from: 'm1', to: 'm2' } }],
      }),
    ]);
  });

  it('change-review: open items on the latest pair, summed over its sets', () => {
    const s = site({
      changes: [
        summary('m2', 'm3', { open: 2 }),
        summary('m2', 'm3', { id: 'm2-m3-detections', producer: 'detections', open: 1 }),
        summary('m1', 'm2', { open: 5 }),
      ],
    });
    expect(siteInsights(s)).toEqual([
      expect.objectContaining({
        id: 'change-review:m2>m3',
        text: {
          key: 'insights.changeReview',
          params: { count: 3, from: '2026-08-01', to: '2026-09-01' },
        },
        evidence: [
          { kind: 'changeSet', id: 'm2-m3-issues' },
          { kind: 'changeSet', id: 'm2-m3-detections' },
        ],
        actions: [
          { id: 'insights.openChanges', pair: { from: 'm2', to: 'm3' } },
          { id: 'date.compare', pair: { from: 'm2', to: 'm3' } },
        ],
      }),
    ]);
  });

  it('pile-departs: the last rate is far off the earlier ones', () => {
    const captures = [
      { id: 'd1', date: '2026-01-01', label: '1' },
      { id: 'd2', date: '2026-01-11', label: '2' },
      { id: 'd3', date: '2026-01-21', label: '3' },
      { id: 'd4', date: '2026-01-31', label: '4' },
      { id: 'd5', date: '2026-02-10', label: '5' },
    ];
    const s = site({
      captures,
      today: '2026-02-11',
      qa: Object.fromEntries(
        captures.slice(1).map((c) => [c.id, qaFile(c.id, { checkpoints: checkpoints(0.02) })]),
      ),
      figures: [fig('a', { d1: 100, d2: 110, d3: 121, d4: 130, d5: 230 }, captures)],
    });
    expect(siteInsights(s)).toEqual([
      expect.objectContaining({
        id: 'pile-departs:a',
        severity: 'warning',
        text: { key: 'insights.pileDeparts', params: { name: 'Pile a', date: '2026-02-10' } },
        actions: [
          { id: 'measure.flyTo', measurement: 'a' },
          { id: 'date.compare', pair: { from: 'd4', to: 'd5' } },
        ],
      }),
    ]);
  });

  it('pile-moved: over 20 % and 5 m3 since the date before, on the latest date only', () => {
    const s = site({
      figures: [
        fig('up', { m1: 100, m2: 100, m3: 130 }),
        fig('down', { m2: 100, m3: 70 }),
        fig('small', { m2: 10, m3: 14 }),
        fig('old', { m1: 100, m2: 10 }),
        fig('fromNothing', { m2: 0, m3: 50 }),
      ],
    });
    const out = siteInsights(s);
    expect(out.map((i) => i.id)).toEqual(['pile-moved:down', 'pile-moved:up']);
    expect(out[1]?.text).toEqual({
      key: 'insights.pileGrew',
      params: {
        name: 'Pile up',
        change: { volume: 30 },
        pct: 30,
        from: '2026-08-01',
        date: '2026-09-01',
      },
    });
    expect(out[0]?.text.key).toBe('insights.pileShrank');
    expect(out[0]?.evidence).toEqual([
      { kind: 'measurement', id: 'down' },
      { kind: 'capture', id: 'm3' },
      { kind: 'capture', id: 'm2' },
    ]);
  });

  it('pile-empties: empty by a date read against today; a warning within 14 days', () => {
    const s = site({
      // -1 m3 a day from 40 on 1 Sep: empty by 11 Oct
      figures: [fig('slow', { m1: 102, m2: 71, m3: 40 })],
    });
    const at = (today: string) =>
      siteInsights({ ...s, today }).filter((i) => i.rule === 'pile-empties');
    expect(at('2026-09-02')).toEqual([
      expect.objectContaining({
        id: 'pile-empties:slow',
        severity: 'info',
        text: { key: 'insights.pileEmpties', params: { name: 'Pile slow', date: '2026-10-11' } },
      }),
    ]);
    expect(at('2026-10-01')[0]?.severity).toBe('warning');
    // empty more than 60 days on: nothing yet
    expect(at('2026-07-01')).toEqual([]);
  });

  it('pile-empties: a figure that would already be empty is a warning', () => {
    const s = site({ figures: [fig('gone', { m1: 102, m2: 71, m3: 40 })], today: '2026-10-20' });
    expect(siteInsights(s).filter((i) => i.rule === 'pile-empties')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        text: { key: 'insights.pileEmptyPast', params: { name: 'Pile gone', date: '2026-09-01' } },
      }),
    ]);
  });

  it('puts critical first, then warnings, then the rest', () => {
    const s = site({
      qa: { m2: qaFile('m2', { status: 'hold' }) },
      changes: [summary('m2', 'm3')],
      figures: [fig('down', { m2: 100, m3: 70 })],
    });
    expect(siteInsights(s).map((i) => i.severity)).toEqual(['critical', 'info', 'info', 'info']);
    expect(rules(s)).toEqual([
      'survey-held:m2',
      'survey-unchecked:m3',
      'change-review:m2>m3',
      'pile-moved:down',
    ]);
  });
});

describe('figuresFromRows', () => {
  it("takes each pile's counted figure per date from the inventory rows", () => {
    const rows = [
      { capture: 'm1', date: '2026-07-01', parts: [{ id: 'a', valueM3: 10 }] },
      // b not counted on m2 (stale, refused or missing): no figure
      { capture: 'm2', date: '2026-08-01', parts: [{ id: 'a', valueM3: 12 }] },
      {
        capture: 'm3',
        date: '2026-09-01',
        parts: [
          { id: 'a', valueM3: 14 },
          { id: 'b', valueM3: 5 },
        ],
      },
    ];
    expect(
      figuresFromRows(rows, [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ]),
    ).toEqual([
      {
        id: 'a',
        label: 'A',
        points: [
          { capture: 'm1', date: '2026-07-01', valueM3: 10 },
          { capture: 'm2', date: '2026-08-01', valueM3: 12 },
          { capture: 'm3', date: '2026-09-01', valueM3: 14 },
        ],
      },
      { id: 'b', label: 'B', points: [{ capture: 'm3', date: '2026-09-01', valueM3: 5 }] },
    ]);
  });
});
