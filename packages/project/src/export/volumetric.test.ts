import { describe, expect, it } from 'vitest';
import type { ReportViewsFrame } from '@aio/schema';
import { defaultSurveySettings } from '@aio/schema';
import {
  stockpileCsv,
  stockpileInventory,
  surveyBasis,
  type CaptureRef,
  type StockpileReport,
  type SurveyReportData,
} from './surveyCsv';
import {
  changeShare,
  formatVolumeM3,
  inShortSentence,
  methodNote,
  pagePlan,
  PILE_CARDS_PER_PAGE,
  pileCrop,
  pileTag,
  pileTonnesShown,
  volumetricCsv,
  volumetricModel,
  type VolumetricInput,
  type VolumetricKey,
  type PlannedPage,
  type VolumetricPileInput,
  type VolumetricPileProfile,
} from './volumetric';

// The strings the model's text uses (a copy of `vreport.short.*` and `vreport.method.*` in
// `@aio/ui` en.ts), with the same placeholder and plural rules as the app's `t`.
const STRINGS: Record<string, string> = {
  'vreport.short.rose': 'Stock on hand rose by {volume} ({pct}) since {date}',
  'vreport.short.fell': 'Stock on hand fell by {volume} ({pct}) since {date}',
  'vreport.short.steady': 'Stock on hand held steady since {date}',
  'vreport.short.mostFrom': 'most of it from {piles}',
  'vreport.short.pileLess': '{pile} ({volume} less)',
  'vreport.short.pileMore': '{pile} ({volume} more)',
  'vreport.short.and': '{a} and {b}',
  'vreport.short.grew': '{pile} grew by {volume}',
  'vreport.short.shrank': '{pile} went down by {volume}',
  'vreport.short.withPiles': '{lead}, {piles}',
  'vreport.short.withCounter': '{lead}; {counter}',
  'vreport.short.end': '{text}.',
  'vreport.short.oneDate_one': 'Stock on hand is {volume} across {count} pile on {date}.',
  'vreport.short.oneDate_other': 'Stock on hand is {volume} across {count} piles on {date}.',
  'vreport.method.base': 'Base: {base}.',
  'vreport.method.basePerPile': 'Base per pile, see table.',
  'vreport.method.cell': 'Surface cell size {cell} m.',
  'vreport.method.gsd': 'Orthophoto ground sample distance {gsd} cm.',
  'vreport.method.crs': 'Coordinate system {crs}.',
  'vreport.method.densityMaterial': "Tonnes at each pile's material density on that date.",
  'vreport.method.densitySite': 'Tonnes at the site-wide density of {density} t/m³.',
  'vreport.method.densityNone': 'No density is set, so no tonnes are given.',
};
const t = (key: VolumetricKey, vars: Record<string, string | number> = {}): string => {
  let message: string | undefined;
  if (typeof vars.count === 'number')
    message = STRINGS[`${key}_${vars.count === 1 ? 'one' : 'other'}`];
  message ??= STRINGS[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
};

const C1: CaptureRef = { id: 'c1', label: 'Survey 1', date: '2026-09-03' };
const C2: CaptureRef = { id: 'c2', label: 'Survey 2', date: '2026-10-01' };

/** A square outline of side `s` metres at (e, n), its lower left corner. */
const square = (e: number, n: number, s: number): [number, number][] => [
  [e, n],
  [e + s, n],
  [e + s, n + s],
  [e, n + s],
];

const name = (i: number) => `P${String(i).padStart(2, '0')}`;

// Pile i was 500 + 300 i m³ on the first date; P04 lost 4,100, P11 lost 2,300, P07 grew by 900,
// every other pile lost 100. P19 has no density (no material).
const deltaOf = (i: number): number => (i === 4 ? -4100 : i === 11 ? -2300 : i === 7 ? 900 : -100);
const previousOf = (i: number): number => (i === 4 ? 6000 : i === 11 ? 4000 : 500 + 300 * i);

function pile(i: number, over: Partial<VolumetricPileInput> = {}): VolumetricPileInput {
  const density = i === 19 ? null : 1.6;
  const prev = previousOf(i);
  return {
    id: `m-${String(i)}`,
    label: name(i),
    material: i === 19 ? null : { id: 'gravel', name: 'Gravel' },
    base: 'Toe surface',
    dates: [
      {
        capture: 'c1',
        volumeM3: prev,
        densityTPerM3: density,
        areaM2: 400,
        peakM: 5,
        plusMinusM3: 10,
        outline: square(1000 + i * 20, 2100, 10),
      },
      {
        capture: 'c2',
        volumeM3: prev + deltaOf(i),
        densityTPerM3: density,
        areaM2: 420,
        peakM: 5.5,
        plusMinusM3: 12,
        outline: square(1002 + i * 20, 2100, 12),
      },
    ],
    ...over,
  };
}

const frame: ReportViewsFrame = {
  schema: 'aio.report-views/1',
  extent: [1000, 2000, 1400, 2300],
  widthPx: 2000,
  heightPx: 1500,
  mPerPx: 0.2,
  views: [],
  markers3d: {},
  fingerprint: 'fp',
};

// listed in a shuffled order, so the ranking is the model's
const ORDER = [5, 12, 1, 19, 4, 8, 16, 2, 11, 7, 14, 3, 18, 9, 6, 13, 10, 17, 15];

const input = (over: Partial<VolumetricInput> = {}): VolumetricInput => ({
  captures: [C1, C2],
  piles: ORDER.map((i) => pile(i)),
  project: { name: 'Demo yard', customer: 'A customer', site: 'The demo yard', crs: 'EPSG:32639' },
  method: { cellM: 0.25, gsdCm: 3.2, siteDensityTPerM3: null },
  frame,
  ...over,
});

const totalPrev = Array.from({ length: 19 }, (_, k) => previousOf(k + 1)).reduce((a, b) => a + b);
const totalChange = Array.from({ length: 19 }, (_, k) => deltaOf(k + 1)).reduce((a, b) => a + b);

describe('pileTag', () => {
  it('takes the number in the name, else a short form, else the rank', () => {
    expect(pileTag('Pile 10', 3)).toBe('10');
    expect(pileTag('P08', 3)).toBe('08');
    expect(pileTag('North heap', 3)).toBe('Nort');
    expect(pileTag('Ab', 3)).toBe('Ab');
    expect(pileTag('  ', 3)).toBe('3');
  });
});

describe('volumetricModel selection and tags', () => {
  it('keeps a pile with no volume on any date, after the measured ones, and gives it a card', () => {
    const bare = pile(30, {
      dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null, peakM: null })),
    });
    const none = pile(31, { dates: [] });
    const m = volumetricModel(input({ piles: [none, bare, ...ORDER.map((i) => pile(i))] }));
    expect(m.piles).toHaveLength(21);
    expect(m.kpis.piles).toBe(19);
    expect(m.kpis.listed).toBe(21);
    // measured piles first, then the rest by name
    expect(m.piles.slice(19).map((p) => p.label)).toEqual(['P30', 'P31']);
    expect(m.piles.map((p) => p.number)).toEqual(Array.from({ length: 21 }, (_, k) => k + 1));
    const p30 = m.piles.find((p) => p.label === 'P30');
    expect(p30?.latestM3).toBeNull();
    expect(p30?.changeM3).toBeNull();
    expect(m.cards).toContain(p30?.id);
    expect(m.cards).toContain('m-31');
    // the stock and the dates are those of the measured piles
    expect(m.kpis.stockM3).toBe(totalPrev + totalChange);
    expect(m.dates.map((d) => d.id)).toEqual(['c1', 'c2']);
  });

  it('counts 3 of 8 listed piles', () => {
    const piles = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      i <= 3 ? pile(i) : pile(i, { dates: pile(i).dates.map((d) => ({ ...d, volumeM3: null })) }),
    );
    const m = volumetricModel(input({ piles }));
    expect(m.kpis.listed).toBe(8);
    expect(m.kpis.piles).toBe(3);
    expect(m.piles).toHaveLength(8);
    expect(m.cards).toHaveLength(8);
  });

  it('gives a pile without a figure the outline and footprint of the date itself', () => {
    const bare = pile(30, {
      dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null, peakM: null })),
    });
    const m = volumetricModel(input({ piles: [...ORDER.map((i) => pile(i)), bare] }));
    const p30 = m.piles.find((p) => p.label === 'P30');
    expect(p30?.outline).toEqual(square(1002 + 30 * 20, 2100, 12));
    expect(p30?.previousOutline).toEqual(square(1000 + 30 * 20, 2100, 10));
    expect(p30?.areaM2).toBe(420);
    expect(p30?.peakM).toBeNull();
    expect(p30?.centre).not.toBeNull();
    expect(p30?.crop).not.toBeNull();
    // a pile with no entry at all has no outline, and nothing fails
    const none = volumetricModel(input({ piles: [pile(1), pile(31, { dates: [] })] }));
    expect(none.piles.find((p) => p.label === 'P31')?.outline).toEqual([]);
  });

  it('lists every pile when none has a volume', () => {
    const piles = [1, 2].map((i) =>
      pile(i, { dates: pile(i).dates.map((d) => ({ ...d, volumeM3: null })) }),
    );
    const m = volumetricModel(input({ piles }));
    expect(m.latest).toBeNull();
    expect(m.piles.map((p) => p.label)).toEqual(['P01', 'P02']);
    expect(m.kpis.piles).toBe(0);
    expect(m.kpis.listed).toBe(2);
    expect(m.share).toEqual([]);
    expect(m.piles[0]?.outline).toEqual(square(1002 + 20, 2100, 12));
  });

  it('gives each pile its own short label, not its rank', () => {
    const m = volumetricModel(input());
    for (const p of m.piles) expect(p.tag).toBe(p.label.slice(1));
  });

  it('falls back to the ranks for every pile when two piles would share a tag', () => {
    const piles = [
      pile(1, { label: 'North 1' }),
      pile(2, { label: 'South 1' }),
      pile(3, { label: 'Pile 7' }),
    ];
    const m = volumetricModel(input({ piles }));
    expect(m.piles.map((p) => p.tag)).toEqual(['1', '2', '3']);
    expect(m.piles.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

describe('volumetricModel below the base, overlaps and profiles', () => {
  /** P01 at `latest` m³ on the second date, beside P02 and P03 as they are. */
  const withP1 = (latest: number) => [
    pile(1, {
      dates: pile(1).dates.map((d) => (d.capture === 'c2' ? { ...d, volumeM3: latest } : d)),
    }),
    pile(2),
    pile(3),
  ];

  it('flags a pile under its base, gives it no percentage and no share of the bar', () => {
    const m = volumetricModel(input({ piles: withP1(-3.9) }));
    const p1 = m.piles.find((p) => p.label === 'P01');
    expect(p1?.belowBase).toBe(true);
    expect(p1?.latestM3).toBe(-3.9);
    expect(p1?.changeM3).toBeCloseTo(-803.9, 9);
    expect(p1?.changePct).toBeNull();
    expect(m.piles.find((p) => p.label === 'P02')?.belowBase).toBe(false);
    expect(m.share.map((s) => s.id)).toEqual(['m-3', 'm-2']);
    expect(m.share.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    // the total stays the app's: the negative pile is still in it
    expect(m.kpis.stockM3).toBeCloseTo(1000 + 1300 - 3.9, 9);
    expect(m.kpis.piles).toBe(3);
    expect(m.cards).toContain('m-1');
  });

  it('prints no tonnes for a pile at or under zero, and still adds them to the site tonnes', () => {
    expect(pileTonnesShown(100, 160)).toBe(160);
    expect(pileTonnesShown(0, 0)).toBeNull();
    expect(pileTonnesShown(-3.9, -6.24)).toBeNull();
    expect(pileTonnesShown(null, null)).toBeNull();
    expect(pileTonnesShown(100, null)).toBeNull();
    // the site's tonnes are the app's own total: every weighed pile, the negative one too
    const m = volumetricModel(input({ piles: withP1(-3.9) }));
    expect(m.kpis.tonnes).toBeCloseTo((1000 + 1300 - 3.9) * 1.6, 9);
    expect(m.kpis.tonnesPiles).toBe(3);
    const p1 = m.piles.find((p) => p.label === 'P01');
    expect(pileTonnesShown(p1?.latestM3 ?? null, p1?.tonnes ?? null)).toBeNull();
  });

  it('leaves a pile at zero out of the share bar without flagging it', () => {
    const m = volumetricModel(input({ piles: withP1(0) }));
    expect(m.piles.find((p) => p.label === 'P01')?.belowBase).toBe(false);
    expect(m.share.some((s) => s.id === 'm-1')).toBe(false);
  });

  it('names the two piles of an overlap, and drops a pair with a pile that has no latest volume', () => {
    const bare = pile(30, { dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null })) });
    const old = pile(31, { dates: pile(31).dates.slice(0, 1) });
    const m = volumetricModel(
      input({
        piles: [pile(1), pile(2), pile(3), bare, old],
        overlaps: [
          { a: 'm-1', b: 'm-3' },
          { a: 'm-2', b: 'm-30' },
          { a: 'm-31', b: 'm-2' },
          { a: 'm-2', b: 'm-99' },
          { a: 'm-2', b: 'm-2' },
        ],
      }),
    );
    expect(m.overlaps).toEqual([
      {
        a: { id: 'm-3', number: 1, tag: '03', label: 'P03' },
        b: { id: 'm-1', number: 3, tag: '01', label: 'P01' },
      },
    ]);
    expect(volumetricModel(input()).overlaps).toEqual([]);
  });

  it('names an overlapping pair once', () => {
    const m = volumetricModel(
      input({
        piles: [pile(1), pile(2)],
        overlaps: [
          { a: 'm-1', b: 'm-2' },
          { a: 'm-2', b: 'm-1' },
        ],
      }),
    );
    expect(m.overlaps).toHaveLength(1);
  });

  it('carries a pile profile to the model, null when it was not sampled', () => {
    const chainage = [0, 6, 12];
    const profile: VolumetricPileProfile = {
      a: [1022, 2106],
      b: [1034, 2106],
      lengthM: 12,
      series: [
        { kind: 'current', capture: 'c2', date: '2026-10-01', chainage, z: [10, 14, 10] },
        { kind: 'earlier', capture: 'c1', date: '2026-09-03', chainage, z: [10, 15, 10] },
        { kind: 'base', chainage, z: [null, 10, null] },
      ],
      baseLevel: [9.8, 10.1],
      baseKind: 'own',
    };
    const m = volumetricModel(input({ piles: [pile(1, { profile }), pile(2)] }));
    expect(m.piles.find((p) => p.label === 'P01')?.profile).toEqual(profile);
    expect(m.piles.find((p) => p.label === 'P02')?.profile).toBeNull();
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe('volumetricModel', () => {
  it('ranks the piles by latest volume, largest first, and numbers them in that order', () => {
    const m = volumetricModel(input());
    const latest = m.piles.map((p) => p.latestM3 ?? 0);
    expect([...latest].sort((a, b) => b - a)).toEqual(latest);
    expect(m.piles.map((p) => p.number)).toEqual(Array.from({ length: 19 }, (_, k) => k + 1));
    expect(m.piles[0]?.label).toBe('P19');
    expect(m.latest?.id).toBe('c2');
    expect(m.compared?.id).toBe('c1');
  });

  it('gives each pile its change between the two dates and its latest figures', () => {
    const m = volumetricModel(input());
    const p4 = m.piles.find((p) => p.label === 'P04');
    expect(p4?.previousM3).toBe(6000);
    expect(p4?.latestM3).toBe(1900);
    expect(p4?.changeM3).toBe(-4100);
    expect(p4?.changePct).toBeCloseTo((-4100 / 6000) * 100, 9);
    expect(p4?.tonnes).toBeCloseTo(1900 * 1.6, 9);
    expect(p4?.areaM2).toBe(420);
    expect(p4?.peakM).toBe(5.5);
    expect(m.piles.find((p) => p.label === 'P19')?.tonnes).toBeNull();
  });

  it('works out the KPIs: stock, tonnes for n of m piles, change and survey error', () => {
    const m = volumetricModel(input());
    expect(m.kpis.stockM3).toBe(totalPrev + totalChange);
    expect(m.kpis.tonnesPiles).toBe(18);
    expect(m.kpis.piles).toBe(19);
    const p19 = previousOf(19) + deltaOf(19);
    expect(m.kpis.tonnes).toBeCloseTo((totalPrev + totalChange - p19) * 1.6, 6);
    expect(m.kpis.changeM3).toBe(totalChange);
    expect(m.kpis.changePct).toBeCloseTo((totalChange / totalPrev) * 100, 9);
    expect(m.kpis.errorM3).toBe(19 * 12);
    expect(m.kpis.errorPct).toBeCloseTo(((19 * 12) / (totalPrev + totalChange)) * 100, 9);
  });

  it('leaves the survey error out when a pile has no uncertainty', () => {
    const piles = ORDER.map((i) => pile(i));
    const first = piles[0];
    if (!first) throw new Error('no pile');
    piles[0] = {
      ...first,
      dates: first.dates.map((d) => (d.capture === 'c2' ? { ...d, plusMinusM3: null } : d)),
    };
    const m = volumetricModel(input({ piles }));
    expect(m.kpis.errorM3).toBeNull();
    expect(m.kpis.errorPct).toBeNull();
  });

  it('gives no tonnes when no pile has a density', () => {
    const piles = ORDER.map((i) =>
      pile(i, {
        dates: pile(i).dates.map((d) => ({ ...d, densityTPerM3: null })),
      }),
    );
    const m = volumetricModel(input({ piles }));
    expect(m.kpis.tonnes).toBeNull();
    expect(m.kpis.tonnesPiles).toBe(0);
  });

  it('splits the share of stock into the 8 largest and Others, summing to one', () => {
    const m = volumetricModel(input());
    expect(m.share).toHaveLength(9);
    expect(m.share.slice(0, 8).map((s) => s.id)).toEqual(m.piles.slice(0, 8).map((p) => p.id));
    expect(m.share[8]?.id).toBeNull();
    expect(m.share.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    expect(m.share[8]?.m3).toBe(m.piles.slice(8).reduce((a, p) => a + (p.latestM3 ?? 0), 0));
  });

  it('has a card for every pile, in report order, and no compact list', () => {
    const m = volumetricModel(input());
    expect(m.cards).toEqual(m.piles.map((p) => p.id));
    expect('compact' in m).toBe(false);
  });

  it('orders the change chart from the largest drawdown to the largest growth', () => {
    const m = volumetricModel(input());
    const byId = new Map(m.piles.map((p) => [p.id, p]));
    const changes = m.changeOrder.map((id) => byId.get(id)?.changeM3 ?? 0);
    expect(changes[0]).toBe(-4100);
    expect(changes.at(-1)).toBe(900);
    expect([...changes].sort((a, b) => a - b)).toEqual(changes);
  });

  it('places the pile markers through the frame from each pile centre', () => {
    const m = volumetricModel(input());
    const p1 = m.piles.find((p) => p.label === 'P01');
    // latest outline: a 12 m square from (1022, 2100), centre (1028, 2106)
    expect(p1?.centre?.[0]).toBeCloseTo(1028, 9);
    expect(p1?.centre?.[1]).toBeCloseTo(2106, 9);
    expect(p1?.marker?.[0]).toBeCloseTo((1028 - 1000) / 0.2, 9);
    expect(p1?.marker?.[1]).toBeCloseTo((2300 - 2106) / 0.2, 9);
    expect(volumetricModel(input({ frame: null })).piles[0]?.marker).toBeNull();
  });

  it('compares with the date the person picked, else the one before the latest', () => {
    const C0: CaptureRef = { id: 'c0', label: 'Survey 0', date: '2026-08-01' };
    const piles = ORDER.map((i) =>
      pile(i, {
        dates: [{ ...(pile(i).dates[0] ?? never()), capture: 'c0' }, ...pile(i).dates],
      }),
    );
    const three = input({ captures: [C0, C1, C2], piles });
    expect(volumetricModel(three).compared?.id).toBe('c1');
    expect(volumetricModel({ ...three, compareWith: 'c0' }).compared?.id).toBe('c0');
    expect(volumetricModel({ ...three, compareWith: 'c2' }).compared?.id).toBe('c1');
    expect(volumetricModel(three).dates.map((d) => d.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('has no change with one date only', () => {
    const piles = ORDER.map((i) => pile(i, { dates: pile(i).dates.slice(1) }));
    const m = volumetricModel(input({ piles }));
    expect(m.compared).toBeNull();
    expect(m.kpis.changeM3).toBeNull();
    expect(m.piles.every((p) => p.changeM3 === null)).toBe(true);
    expect(m.changeOrder).toEqual([]);
  });

  it('carries the text, the notes and the page choice, and is JSON safe', () => {
    const m = volumetricModel(
      input({
        text: { title: 'Month end', summary: 'All good.' },
        pileNotes: { 'm-4': 'Loaded out for the road job.' },
        pages: { piles: false },
      }),
    );
    expect(m.text.title).toBe('Month end');
    expect(m.piles.find((p) => p.id === 'm-4')?.note).toBe('Loaded out for the road job.');
    expect(m.piles.find((p) => p.id === 'm-5')?.note).toBeNull();
    expect(m.pages).toEqual({ cover: true, piles: false, change: true });
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

function never(): never {
  throw new Error('missing fixture');
}

describe('formatVolumeM3', () => {
  it('groups thousands and drops decimals above 100 m³', () => {
    expect(formatVolumeM3(12499.4)).toBe('12,499 m³');
    expect(formatVolumeM3(99.94)).toBe('99.9 m³');
    expect(formatVolumeM3(-4100)).toBe('4,100 m³');
  });
});

describe('inShortSentence', () => {
  it('says the stock fell, most of it from two piles, with the pile that grew', () => {
    const s = inShortSentence(volumetricModel(input()), t);
    const pct = Math.round((Math.abs(totalChange) / totalPrev) * 100);
    expect(s).toBe(
      `Stock on hand fell by ${formatVolumeM3(-totalChange)} (${String(pct)} %) since 3 September 2026, ` +
        'most of it from P04 (4,100 m³ less) and P11 (2,300 m³ less); P07 grew by 900 m³.',
    );
    expect(s).not.toMatch(/[-–—]/);
  });

  it('says the stock rose, and leaves out a counter-mover under 5 % of the change', () => {
    const piles = ORDER.map((i) => {
      const p = pile(i);
      const d = i === 4 ? 3000 : i === 11 ? 2000 : i === 7 ? -100 : 0;
      return {
        ...p,
        dates: p.dates.map((x) => (x.capture === 'c2' ? { ...x, volumeM3: previousOf(i) + d } : x)),
      };
    });
    const s = inShortSentence(volumetricModel(input({ piles })), t);
    expect(s).toMatch(/^Stock on hand rose by 4,900 m³ \(\d+ %\) since 3 September 2026, /);
    expect(s).toContain('most of it from P04 (3,000 m³ more) and P11 (2,000 m³ more).');
    expect(s).not.toContain('P07');
  });

  it('names the counter-mover that went down when the stock rose', () => {
    const piles = ORDER.map((i) => {
      const p = pile(i);
      const d = i === 4 ? 3000 : i === 7 ? -400 : 0;
      return {
        ...p,
        dates: p.dates.map((x) => (x.capture === 'c2' ? { ...x, volumeM3: previousOf(i) + d } : x)),
      };
    });
    const s = inShortSentence(volumetricModel(input({ piles })), t);
    expect(s).toContain('most of it from P04 (3,000 m³ more); P07 went down by 400 m³.');
  });

  it('says the stock held steady when the change is under 1 % of the stock', () => {
    const piles = ORDER.map((i) => {
      const p = pile(i);
      return {
        ...p,
        dates: p.dates.map((x) =>
          x.capture === 'c2' ? { ...x, volumeM3: previousOf(i) + (i === 1 ? -50 : 0) } : x,
        ),
      };
    });
    expect(inShortSentence(volumetricModel(input({ piles })), t)).toBe(
      'Stock on hand held steady since 3 September 2026.',
    );
  });

  it('gives the stock on hand with one date only', () => {
    const piles = ORDER.map((i) => pile(i, { dates: pile(i).dates.slice(1) }));
    const m = volumetricModel(input({ piles }));
    expect(inShortSentence(m, t)).toBe(
      `Stock on hand is ${formatVolumeM3(m.kpis.stockM3)} across 19 piles on 1 October 2026.`,
    );
    const one = volumetricModel(input({ piles: piles.slice(0, 1) }));
    expect(inShortSentence(one, t)).toContain('across 1 pile on');
  });
});

describe('methodNote', () => {
  it('names the base, cell, GSD, CRS and the material density', () => {
    expect(methodNote(volumetricModel(input()), t)).toBe(
      'Base: Toe surface. Surface cell size 0.25 m. Orthophoto ground sample distance 3.2 cm. ' +
        "Coordinate system EPSG:32639. Tonnes at each pile's material density on that date.",
    );
  });

  it('gives the site-wide density of kit piles and leaves out what is unknown', () => {
    const piles = ORDER.map((i) => pile(i, { material: { id: 'kit', name: 'Stockpile' } }));
    const m = volumetricModel(
      input({ piles, method: { cellM: null, gsdCm: null, siteDensityTPerM3: 1.6 } }),
    );
    expect(methodNote(m, t)).toBe(
      'Base: Toe surface. Coordinate system EPSG:32639. Tonnes at the site-wide density of 1.60 t/m³.',
    );
  });

  it('says the base per pile when the piles do not share one', () => {
    const piles = ORDER.map((i) => pile(i, i === 4 ? { base: 'Previous survey' } : {}));
    const note = methodNote(volumetricModel(input({ piles })), t);
    expect(note).toContain('Base per pile, see table.');
    expect(note).not.toContain('Base: ');
  });

  it('says the base per pile when one pile has no known base', () => {
    const piles = ORDER.map((i) => pile(i, i === 4 ? { base: '' } : {}));
    const note = methodNote(volumetricModel(input({ piles })), t);
    expect(note).toContain('Base per pile, see table.');
    expect(note).not.toContain('Base: ');
  });

  it('reads the base from the measured piles only', () => {
    // a pile nobody computed has no base that the figures rest on
    const bare = (over: Partial<VolumetricPileInput>) =>
      pile(30, { dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null })), ...over });
    for (const base of ['', 'Lowest point']) {
      const piles = [...ORDER.map((i) => pile(i)), bare({ base })];
      const m = volumetricModel(input({ piles }));
      expect(m.method.bases).toEqual(['Toe surface']);
      expect(methodNote(m, t)).toContain('Base: Toe surface.');
    }
  });

  it('says there are no tonnes without a density', () => {
    const piles = ORDER.map((i) =>
      pile(i, {
        material: null,
        dates: pile(i).dates.map((d) => ({ ...d, densityTPerM3: null })),
      }),
    );
    expect(methodNote(volumetricModel(input({ piles })), t)).toContain(
      'No density is set, so no tonnes are given.',
    );
  });
});

describe('pileCrop', () => {
  it('squares the union of both outlines with a 25 % margin, in frame pixels', () => {
    // union 1000..1030 by 2100..2110: 30 m wide, centre (1015, 2105); side 30 x 1.5 = 45 m
    const box = pileCrop([square(1000, 2100, 10), square(1020, 2100, 10)], frame);
    expect(box).not.toBeNull();
    expect(box?.size).toBeCloseTo(45 / 0.2, 9);
    expect(box?.x).toBeCloseTo((1015 - 22.5 - 1000) / 0.2, 9);
    expect(box?.y).toBeCloseTo((2300 - (2105 + 22.5)) / 0.2, 9);
  });

  it('is at least 20 m a side', () => {
    const box = pileCrop([square(1100, 2100, 4)], frame);
    expect(box?.size).toBeCloseTo(20 / 0.2, 9);
    expect(box?.x).toBeCloseTo((1102 - 10 - 1000) / 0.2, 9);
  });

  it('is null without a frame or an outline', () => {
    expect(pileCrop([square(1100, 2100, 4)], null)).toBeNull();
    expect(pileCrop([[]], frame)).toBeNull();
  });

  it('is in the model for every pile with an outline', () => {
    const m = volumetricModel(input());
    const p1 = m.piles.find((p) => p.label === 'P01');
    expect(p1?.crop).toEqual(pileCrop([square(1020, 2100, 10), square(1022, 2100, 12)], frame));
  });
});

describe('pagePlan', () => {
  const cols = (plan: PlannedPage[]) =>
    plan.map((p) => [p.page, p.part ?? null, p.continued, p.from, p.to]);

  it('lays 5 piles with a compared date out as cover, overview, 3 card pages and change', () => {
    const m = volumetricModel(input({ piles: [1, 2, 3, 4, 5].map((i) => pile(i)) }));
    const plan = pagePlan(m);
    expect(PILE_CARDS_PER_PAGE).toBe(2);
    expect(cols(plan)).toEqual([
      ['cover', null, false, 0, 5],
      ['piles', 'overview', false, 0, 0],
      ['piles', 'cards', false, 0, 2],
      ['piles', 'cards', true, 2, 4],
      ['piles', 'cards', true, 4, 5],
      ['change', null, false, 0, 5],
    ]);
    expect(plan.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('has neither the overview nor the cards with the piles page off', () => {
    const m = volumetricModel(input({ piles: [1, 2, 3, 4, 5].map((i) => pile(i)) }));
    expect(pagePlan(m, { piles: false }).map((p) => p.page)).toEqual(['cover', 'change']);
    expect(
      pagePlan(volumetricModel(input({ pages: { piles: false } }))).some((p) => p.page === 'piles'),
    ).toBe(false);
  });

  it('has no change page with one date', () => {
    const piles = [1, 2, 3, 4, 5].map((i) => pile(i, { dates: pile(i).dates.slice(1) }));
    const plan = pagePlan(volumetricModel(input({ piles })));
    expect(plan.map((p) => [p.page, p.part ?? null])).toEqual([
      ['cover', null],
      ['piles', 'overview'],
      ['piles', 'cards'],
      ['piles', 'cards'],
      ['piles', 'cards'],
    ]);
  });

  it('ends on a closing page when the last page would hold two cards', () => {
    // two cards fill a page, so the closing remarks and the method note get a page of their own
    const one = (n: number) =>
      Array.from({ length: n }, (_, k) => pile(k + 1, { dates: pile(k + 1).dates.slice(1) }));
    expect(cols(pagePlan(volumetricModel(input({ piles: one(4) }))))).toEqual([
      ['cover', null, false, 0, 4],
      ['piles', 'overview', false, 0, 0],
      ['piles', 'cards', false, 0, 2],
      ['piles', 'cards', true, 2, 4],
      ['piles', 'closing', true, 4, 4],
    ]);
    // a last page with one card has the other card's room, and a change page closes by itself
    expect(pagePlan(volumetricModel(input({ piles: one(3) }))).at(-1)?.part).toBe('cards');
    const two = volumetricModel(input({ piles: [1, 2, 3, 4].map((i) => pile(i)) }));
    expect(pagePlan(two).some((p) => p.part === 'closing')).toBe(false);
    // the change page switched off: the pile pages end the report again
    expect(pagePlan(two, { change: false }).at(-1)).toMatchObject({
      page: 'piles',
      part: 'closing',
      from: 4,
      to: 4,
    });
  });

  it('gives a pile without a volume its card, and keeps it out of the change bars', () => {
    const bare = pile(30, { dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null })) });
    const plan = pagePlan(volumetricModel(input({ piles: [pile(1), pile(2), bare] })));
    expect(cols(plan)).toEqual([
      ['cover', null, false, 0, 3],
      ['piles', 'overview', false, 0, 0],
      ['piles', 'cards', false, 0, 2],
      ['piles', 'cards', true, 2, 3],
      ['change', null, false, 0, 2],
    ]);
  });

  it('continues the cover and the change page at their own row counts', () => {
    const piles = Array.from({ length: 80 }, (_, k) => {
      const p = pile((k % 19) + 1);
      return { ...p, id: `m-x${String(k)}`, label: `P${String(k + 1).padStart(2, '0')}` };
    });
    const plan = pagePlan(volumetricModel(input({ piles })));
    const of = (page: string) =>
      plan.filter((p) => p.page === page).map((p) => [p.continued, p.from, p.to]);
    expect(of('cover')).toEqual([
      [false, 0, 12],
      [true, 12, 42],
      [true, 42, 72],
      [true, 72, 80],
    ]);
    // one overview page, then 80 cards two to a page
    const b = plan.filter((p) => p.page === 'piles');
    expect(b).toHaveLength(41);
    expect(b.filter((p) => p.part === 'overview')).toHaveLength(1);
    expect(b.at(-1)).toMatchObject({ part: 'cards', continued: true, from: 78, to: 80 });
    expect(of('change')).toEqual([
      [false, 0, 24],
      [true, 24, 64],
      [true, 64, 80],
    ]);
    expect(plan.map((p) => p.number)).toEqual(plan.map((_, k) => k + 1));
  });

  it('prints the pages turned on, leaves C out with one date and keeps one page', () => {
    const m = volumetricModel(input());
    expect(pagePlan(m, { cover: false, piles: false }).map((p) => p.page)).toEqual(['change']);
    // 19 piles: two cover pages, the overview and 10 card pages
    expect(
      pagePlan(volumetricModel(input({ pages: { change: false } }))).map((p) => p.page),
    ).toEqual(['cover', 'cover', ...Array.from({ length: 11 }, () => 'piles')]);
    const one = volumetricModel(
      input({ piles: ORDER.map((i) => pile(i, { dates: pile(i).dates.slice(1) })) }),
    );
    expect(pagePlan(one, { cover: false, piles: false }).map((p) => p.page)).toEqual([
      'cover',
      'cover',
    ]);
    expect(pagePlan(m, { cover: false, piles: false, change: false })[0]?.page).toBe('cover');
  });
});

describe('volumetricCsv', () => {
  const C0: CaptureRef = { id: 'c0', label: 'Survey 0', date: '2026-08-01' };
  const captures = [C0, C1, C2];
  const reports: StockpileReport[] = [1, 2, 3].map((i) => ({
    ref: `M${String(i)}`,
    id: `m-${String(i)}`,
    label: name(i),
    material: { id: 'gravel', name: 'Gravel', densityTPerM3: 1.6 },
    base: 'Toe surface',
    volumes: captures.map((c, k) => ({
      capture: c,
      volumeM3: 1000 * i + 100 * k,
      status: 'ok' as const,
      reason: '',
    })),
  }));
  const settings = defaultSurveySettings();
  const data: SurveyReportData = {
    basis: surveyBasis(settings, { epsg: 32639 }, null),
    captures,
    current: C2,
    computed: true,
    measurementCount: 3,
    measurements: [],
    stockpiles: stockpileInventory(reports, captures),
    earthworks: [],
    sections: [],
    landfill: [],
  };

  it('is the stockpile inventory CSV for the default dates', () => {
    expect(volumetricCsv(data)).toBe(stockpileCsv(data));
    expect(volumetricCsv(data, 'c1')).toBe(stockpileCsv(data));
  });

  it('is the stockpile inventory CSV of the two dates compared', () => {
    const two = [C0, C2];
    const expected = stockpileCsv({
      ...data,
      stockpiles: stockpileInventory(
        reports.map((r) => ({ ...r, volumes: r.volumes.filter((v) => v.capture.id !== 'c1') })),
        two,
      ),
    });
    expect(volumetricCsv(data, 'c0')).toBe(expected);
    expect(expected).toContain('2026-08-01');
    expect(expected).not.toContain('2026-09-03_volume_m3');
  });
});

describe('changeShare', () => {
  it('is the change in per cent of the previous volume', () => {
    expect(changeShare(-4100, 6000)).toBeCloseTo(-68.33, 1);
    expect(changeShare(-50, 100)).toBeCloseTo(-50, 9);
    expect(changeShare(25, 100)).toBeCloseTo(25, 9);
  });

  it('is null unless the earlier and the latest volume are both above zero', () => {
    // 93.1 m³ before, -3.9 m³ now
    expect(changeShare(-97, 93.1)).toBeNull();
    expect(changeShare(-100, 100)).toBeNull();
    expect(changeShare(-50, -200)).toBeNull();
    expect(changeShare(250, -200)).toBeNull();
  });

  it('is null when the previous volume is about zero or the share runs away', () => {
    expect(changeShare(1131, 0.0004)).toBeNull();
    expect(changeShare(1131, 0.9)).toBeNull();
    expect(changeShare(5000, 4)).toBeNull();
    expect(changeShare(10, null)).toBeNull();
  });
});
