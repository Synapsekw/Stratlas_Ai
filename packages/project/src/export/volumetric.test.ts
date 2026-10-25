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
  pileCrop,
  pileTag,
  volumetricCsv,
  volumetricModel,
  type VolumetricInput,
  type VolumetricKey,
  type VolumetricPileInput,
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
    base: 'Smart base',
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
  it('leaves out piles with no volume on any date, and counts only the rest', () => {
    const bare = pile(30, {
      dates: pile(30).dates.map((d) => ({ ...d, volumeM3: null })),
    });
    const none = pile(31, { dates: [] });
    const m = volumetricModel(input({ piles: [...ORDER.map((i) => pile(i)), bare, none] }));
    expect(m.piles).toHaveLength(19);
    expect(m.kpis.piles).toBe(19);
    expect(m.piles.some((p) => p.label === 'P30' || p.label === 'P31')).toBe(false);
  });

  it('gives each pile its own short label, not its rank', () => {
    const m = volumetricModel(input());
    for (const p of m.piles) expect(p.tag).toBe(p.label.slice(1));
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

  it('has cards for the 8 largest piles and a compact list for the rest', () => {
    const m = volumetricModel(input());
    expect(m.cards).toEqual(m.piles.slice(0, 8).map((p) => p.id));
    expect(m.compact).toEqual(m.piles.slice(8).map((p) => p.id));
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
      'Base: Smart base. Surface cell size 0.25 m. Orthophoto ground sample distance 3.2 cm. ' +
        "Coordinate system EPSG:32639. Tonnes at each pile's material density on that date.",
    );
  });

  it('gives the site-wide density of kit piles and leaves out what is unknown', () => {
    const piles = ORDER.map((i) => pile(i, { material: { id: 'kit', name: 'Stockpile' } }));
    const m = volumetricModel(
      input({ piles, method: { cellM: null, gsdCm: null, siteDensityTPerM3: 1.6 } }),
    );
    expect(methodNote(m, t)).toBe(
      'Base: Smart base. Coordinate system EPSG:32639. Tonnes at the site-wide density of 1.60 t/m³.',
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
  it('lays 19 piles out on A, A continued, B and C', () => {
    const plan = pagePlan(volumetricModel(input()));
    expect(plan.map((p) => [p.page, p.continued, p.from, p.to])).toEqual([
      ['cover', false, 0, 12],
      ['cover', true, 12, 19],
      ['piles', false, 0, 11],
      ['change', false, 0, 19],
    ]);
    expect(plan.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });

  it('continues each page at its own row counts', () => {
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
    // 72 compact rows: 24 on B, then 40 and 8
    expect(of('piles')).toEqual([
      [false, 0, 24],
      [true, 24, 64],
      [true, 64, 72],
    ]);
    expect(of('change')).toEqual([
      [false, 0, 24],
      [true, 24, 64],
      [true, 64, 80],
    ]);
  });

  it('prints the pages turned on, leaves C out with one date and keeps one page', () => {
    const m = volumetricModel(input());
    expect(pagePlan(m, { cover: false, piles: false }).map((p) => p.page)).toEqual(['change']);
    expect(
      pagePlan(volumetricModel(input({ pages: { change: false } }))).map((p) => p.page),
    ).toEqual(['cover', 'cover', 'piles']);
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
    base: 'Smart base',
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
  it('is the change against the previous magnitude', () => {
    expect(changeShare(-4100, 6000)).toBeCloseTo(-68.33, 1);
    expect(changeShare(-50, -200)).toBeCloseTo(-25, 5);
    expect(changeShare(50, -200)).toBeCloseTo(25, 5);
  });

  it('is null when the previous volume is about zero or the share runs away', () => {
    expect(changeShare(1131, 0.0004)).toBeNull();
    expect(changeShare(1131, 0.9)).toBeNull();
    expect(changeShare(5000, 4)).toBeNull();
    expect(changeShare(10, null)).toBeNull();
  });
});
