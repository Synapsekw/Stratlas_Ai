import { readFileSync } from 'node:fs';
import { AntennasFile, type AntennaUnit } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { antennasToCsv, CSV_COLUMNS } from './antennaCsv';

const contract = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { example: unknown };

/** The contract example with its three units set to accepted, draft and rejected. */
function sample(): AntennasFile {
  const f = AntennasFile.parse(structuredClone(contract.example));
  const status = ['accepted', 'draft', 'rejected'] as const;
  return { ...f, units: f.units.map((u, i) => ({ ...u, status: status[i] ?? 'draft' })) };
}
const lines = (csv: string) => csv.trimEnd().split('\r\n');
const cell = (csv: string, line: number, column: string) => {
  const cells = (lines(csv)[line] ?? '').split(',');
  return cells[CSV_COLUMNS.indexOf(column)];
};

describe('antennasToCsv', () => {
  it('exports accepted units only by default, with basis columns', () => {
    const csv = antennasToCsv(sample(), { includeDrafts: false });
    expect(lines(csv)[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines(csv)).toHaveLength(2);
    expect(cell(csv, 1, 'id')).toBe('ant-a3');
    expect(cell(csv, 1, 'status')).toBe('accepted');
    expect(cell(csv, 1, 'azimuthGridDeg')).toBe('120');
    expect(cell(csv, 1, 'azimuthBasis')).toBe('measured');
    expect(cell(csv, 1, 'downtiltBasis')).toBe('measured');
    expect(cell(csv, 1, 'widthM')).toBe('0.3');
    expect(cell(csv, 1, 'altitudeM')).toBe('31.5');
    expect(cell(csv, 1, 'residualMm')).toBe('4');
  });

  it('adds drafts when asked and never rejected units', () => {
    const csv = antennasToCsv(sample(), { includeDrafts: true });
    const statuses = lines(csv)
      .slice(1)
      .map((_, i) => cell(csv, i + 1, 'status'));
    expect(statuses).toEqual(['accepted', 'draft']);
    const rejectedId = sample().units[2]?.id ?? '';
    expect(csv).not.toContain(rejectedId);
  });

  it('leaves true azimuth empty without convergence and escapes quotes', () => {
    const f = sample();
    const first = f.units[0];
    if (!first) throw new Error('fixture has no unit');
    const withNorth = antennasToCsv(
      { ...f, units: [{ ...first, convergenceDeg: 2 }] },
      { includeDrafts: false },
    );
    expect(cell(withNorth, 1, 'azimuthTrueDeg')).toBe('122');
    expect(cell(withNorth, 1, 'convergenceDeg')).toBe('2');

    const local = {
      ...f,
      units: [
        {
          ...first,
          convergenceDeg: null,
          user: { model: 'A "big", one', frequencies: '=1+1' },
        },
      ],
    };
    const csv = antennasToCsv(local, { includeDrafts: false });
    expect(cell(csv, 1, 'azimuthTrueDeg')).toBe('');
    expect(cell(csv, 1, 'convergenceDeg')).toBe('');
    expect(cell(csv, 1, 'azimuthGridDeg')).toBe('120');
    expect(csv).toContain('"A ""big"", one"');
    // a typed value that starts with = must not run as a formula
    expect(csv).toContain(",'=1+1,");
  });

  it('writes the origin column after status', () => {
    expect(CSV_COLUMNS.indexOf('origin')).toBe(CSV_COLUMNS.indexOf('status') + 1);
    const f = sample();
    const [a, b] = f.units;
    if (!a || !b) throw new Error('fixture has too few units');
    const csv = antennasToCsv(
      { ...f, units: [a, { ...b, status: 'accepted', origin: 'flagged' }] },
      { includeDrafts: false },
    );
    expect(cell(csv, 1, 'origin')).toBe('detected');
    expect(cell(csv, 2, 'origin')).toBe('flagged');
  });

  it('leaves the size cells of a not-measured unit empty', () => {
    const f = sample();
    const first = f.units[0];
    if (!first) throw new Error('fixture has no unit');
    const rest: AntennaUnit = { ...first };
    delete rest.azimuthGridDeg;
    delete rest.downtiltDeg;
    delete rest.plumbDeg;
    delete rest.widthM;
    delete rest.heightM;
    delete rest.depthM;
    const csv = antennasToCsv(
      { ...f, units: [{ ...rest, status: 'accepted', origin: 'flagged', support: 0 }] },
      { includeDrafts: false },
    );
    for (const c of ['widthM', 'heightM', 'depthM', 'depthBasis', 'azimuthGridDeg', 'residualMm'])
      expect(cell(csv, 1, c)).toBe('');
    expect(cell(csv, 1, 'origin')).toBe('flagged');
  });
});
