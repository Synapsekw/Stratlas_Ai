/**
 * The e2e helper that reads the app's "Volume over time" CSV and compares its figures with a
 * reference CSV (`e2e/volumeReference.ts`): parsing, matching, differences and the table.
 */
import { describe, expect, it } from 'vitest';
import {
  compareVolumes,
  formatComparison,
  parseCsv,
  parseReference,
  parseSeriesCsv,
  PILE_TOLERANCE_PCT,
  siteTotals,
  TOTAL_TOLERANCE_PCT,
} from '../e2e/volumeReference';

const BOM = String.fromCharCode(0xfeff);
const HEAD =
  'Measurement,Folder,Date,Survey,Volume (m³),Change (m³),Tonnage (t),Status,From an earlier version';

/** The app's CSV for two piles on two dates. */
const SERIES = `${BOM}${[
  HEAD,
  'North pile,Stockpiles,2026-01-01,First survey,100,,160,ok,no',
  'North pile,Stockpiles,2026-02-01,Second survey,110.5,10.5,176.8,ok,no',
  '"South, lower",Stockpiles,2026-01-01,First survey,50,,,stale,yes',
  '"South, lower",Stockpiles,2026-02-01,Second survey,,,,refused: the survey does not cover it,no',
].join('\r\n')}\r\n`;

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, both line ends and a leading BOM', () => {
    expect(parseCsv(`${BOM}a,"b, c","say ""hi"""\r\n1,,3\n"two\nlines",x,y\n`)).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '', '3'],
      ['two\nlines', 'x', 'y'],
    ]);
  });

  it('leaves blank lines out', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseSeriesCsv', () => {
  it('reads a row per pile and date, with the unit, the status and the carried mark', () => {
    const got = parseSeriesCsv(SERIES);
    expect(got.unit).toBe('m³');
    expect(got.rows).toEqual([
      { pile: 'North pile', date: '2026-01-01', volume: 100, status: 'ok', carried: false },
      { pile: 'North pile', date: '2026-02-01', volume: 110.5, status: 'ok', carried: false },
      { pile: 'South, lower', date: '2026-01-01', volume: 50, status: 'stale', carried: true },
      {
        pile: 'South, lower',
        date: '2026-02-01',
        volume: null,
        status: 'refused: the survey does not cover it',
        carried: false,
      },
    ]);
  });

  it('refuses a file that is not the volume over time CSV', () => {
    expect(() => parseSeriesCsv('pile,date,volume_m3\nA,2026-01-01,1\n')).toThrow(/Measurement/);
    expect(() => parseSeriesCsv('')).toThrow(/empty/);
  });
});

describe('siteTotals', () => {
  it('adds the piles with a figure per date, in date order', () => {
    expect(siteTotals(parseSeriesCsv(SERIES).rows)).toEqual([
      { date: '2026-01-01', volume: 150, piles: 2 },
      { date: '2026-02-01', volume: 110.5, piles: 1 },
    ]);
  });
});

describe('parseReference', () => {
  it('reads piles and TOTAL rows, whatever the case of the header and of TOTAL', () => {
    const ref = parseReference(
      'Pile, Date ,Volume_m3\nNorth pile,2026-01-01,101\ntotal,2026-01-01,151.5\n"South, lower",2026-01-01,"49"\n',
    );
    expect(ref).toEqual([
      { pile: 'North pile', date: '2026-01-01', volume: 101, total: false },
      { pile: 'TOTAL', date: '2026-01-01', volume: 151.5, total: true },
      { pile: 'South, lower', date: '2026-01-01', volume: 49, total: false },
    ]);
  });

  it('refuses another header, a date that is not YYYY-MM-DD and a volume that is no number', () => {
    expect(() => parseReference('name,date,volume\nA,2026-01-01,1\n')).toThrow(
      /pile,date,volume_m3/,
    );
    expect(() => parseReference('pile,date,volume_m3\nA,01/02/2026,1\n')).toThrow(/line 2.*date/);
    expect(() => parseReference('pile,date,volume_m3\nA,2026-01-01,many\n')).toThrow(
      /line 2.*volume/,
    );
    expect(() => parseReference('pile,date,volume_m3\nA,2026-01-01,\n')).toThrow(/line 2.*volume/);
  });

  it('refuses the same pile and date twice', () => {
    expect(() => parseReference('pile,date,volume_m3\nA,2026-01-01,1\n a ,2026-01-01,2\n')).toThrow(
      /line 3.*twice/,
    );
  });
});

describe('compareVolumes', () => {
  const ours = parseSeriesCsv(SERIES).rows;

  it('uses 5 % per pile and 1 % per total by default', () => {
    expect(PILE_TOLERANCE_PCT).toBe(5);
    expect(TOTAL_TOLERANCE_PCT).toBe(1);
  });

  it('passes when every pile is within 5 % and every total within 1 %', () => {
    const c = compareVolumes(
      ours,
      parseReference(
        [
          'pile,date,volume_m3',
          'north pile,2026-01-01,104',
          'North  pile,2026-02-01,106',
          '"South, lower",2026-01-01,50',
          'TOTAL,2026-01-01,151',
        ].join('\n'),
      ),
    );
    expect(c.ok).toBe(true);
    expect(c.rows.map((r) => [r.pile, r.date, r.ours, r.reference, r.limitPct, r.ok])).toEqual([
      ['North pile', '2026-01-01', 100, 104, 5, true],
      ['North pile', '2026-02-01', 110.5, 106, 5, true],
      ['South, lower', '2026-01-01', 50, 50, 5, true],
      ['TOTAL', '2026-01-01', 150, 151, 1, true],
    ]);
    expect(c.rows[0]?.diffPct).toBeCloseTo(-3.846, 2);
    expect(c.rows[3]?.diffPct).toBeCloseTo(-0.662, 2);
    expect(c.missingInOurs).toEqual([]);
    // the refused date has no figure and no reference: listed, not compared
    expect(c.missingInReference).toEqual([
      { pile: 'South, lower', date: '2026-02-01' },
      { pile: 'TOTAL', date: '2026-02-01' },
    ]);
  });

  it('fails a pile more than 5 % off and a total more than 1 % off', () => {
    const c = compareVolumes(
      ours,
      parseReference(
        'pile,date,volume_m3\nNorth pile,2026-01-01,94\nTOTAL,2026-01-01,147\nTOTAL,2026-02-01,110\n',
      ),
    );
    expect(c.ok).toBe(false);
    expect(c.rows.map((r) => [r.pile, r.date, r.ok])).toEqual([
      ['North pile', '2026-01-01', false],
      ['TOTAL', '2026-01-01', false],
      ['TOTAL', '2026-02-01', true],
    ]);
  });

  it('lists what the reference names and the app has no figure for, without failing on it', () => {
    const c = compareVolumes(
      ours,
      parseReference(
        [
          'pile,date,volume_m3',
          'North pile,2026-01-01,100',
          'East pile,2026-01-01,10',
          '"South, lower",2026-02-01,40',
          'North pile,2026-03-01,120',
          'TOTAL,2026-03-01,120',
        ].join('\n'),
      ),
    );
    expect(c.ok).toBe(true);
    expect(c.rows).toHaveLength(1);
    expect(c.missingInOurs).toEqual([
      { pile: 'East pile', date: '2026-01-01', why: 'no pile of this name' },
      {
        pile: 'South, lower',
        date: '2026-02-01',
        why: 'no figure: refused: the survey does not cover it',
      },
      { pile: 'North pile', date: '2026-03-01', why: 'no such date' },
      { pile: 'TOTAL', date: '2026-03-01', why: 'no such date' },
    ]);
  });

  it('names piles that share a name, and compares none of them', () => {
    const twice = [
      ...ours,
      { pile: 'north PILE', date: '2026-01-01', volume: 7, status: 'ok', carried: false },
    ];
    const c = compareVolumes(
      twice,
      parseReference('pile,date,volume_m3\nNorth pile,2026-01-01,100\n'),
    );
    expect(c.duplicates).toEqual(['North pile']);
    expect(c.rows).toEqual([]);
    expect(c.missingInOurs).toEqual([
      { pile: 'North pile', date: '2026-01-01', why: 'several piles of this name' },
    ]);
    // the total still counts both
    expect(siteTotals(twice)[0]).toEqual({ date: '2026-01-01', volume: 157, piles: 3 });
  });

  it('compares a reference of zero by the figure itself', () => {
    const zero = [{ pile: 'A', date: '2026-01-01', volume: 0, status: 'ok', carried: false }];
    const some = [{ pile: 'A', date: '2026-01-01', volume: 2, status: 'ok', carried: false }];
    const ref = parseReference('pile,date,volume_m3\nA,2026-01-01,0\n');
    expect(compareVolumes(zero, ref).rows[0]).toMatchObject({ diffPct: 0, ok: true });
    expect(compareVolumes(some, ref).rows[0]).toMatchObject({ diffPct: Infinity, ok: false });
  });

  it('takes other tolerances', () => {
    const ref = parseReference('pile,date,volume_m3\nNorth pile,2026-01-01,104\n');
    expect(compareVolumes(ours, ref, { pilePct: 2 }).ok).toBe(false);
    expect(compareVolumes(ours, ref, { pilePct: 10 }).ok).toBe(true);
  });
});

describe('formatComparison', () => {
  it('writes a table of pile, date, ours, reference and the difference in %, then what is missing', () => {
    const c = compareVolumes(
      parseSeriesCsv(SERIES).rows,
      parseReference(
        [
          'pile,date,volume_m3',
          'North pile,2026-01-01,94',
          'North pile,2026-02-01,110',
          'East pile,2026-01-01,10',
          'TOTAL,2026-01-01,150.5',
        ].join('\n'),
      ),
    );
    const text = formatComparison(c);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^pile +date +ours m3 +reference m3 +diff % +limit % +result$/);
    expect(lines.find((l) => l.startsWith('North pile') && l.includes('2026-01-01'))).toMatch(
      /North pile +2026-01-01 +100\.0 +94\.0 +\+6\.38 +5 +FAIL$/,
    );
    expect(lines.find((l) => l.startsWith('North pile') && l.includes('2026-02-01'))).toMatch(
      /\+0\.45 +5 +ok$/,
    );
    expect(lines.find((l) => l.startsWith('TOTAL'))).toMatch(
      /TOTAL +2026-01-01 +150\.0 +150\.5 +-0\.33 +1 +ok$/,
    );
    expect(text).toContain('In the reference, not in the app:');
    expect(text).toContain('East pile 2026-01-01 (no pile of this name)');
    expect(text).toContain('In the app, not in the reference:');
    expect(text).toContain('South, lower 2026-01-01');
    expect(text).toContain('1 of 3 compared figures outside its limit');
  });

  it('says so when nothing was compared', () => {
    const c = compareVolumes([], parseReference('pile,date,volume_m3\nA,2026-01-01,1\n'));
    expect(formatComparison(c)).toContain('No figure could be compared');
  });
});
