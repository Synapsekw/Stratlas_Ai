import { describe, expect, it } from 'vitest';
import type { RfCatalogueEntry } from '@aio/schema';
import {
  AAU_ENTRY,
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  lteSettings,
  sectorsFile,
  unit,
} from './__fixtures__/rfData';
import { applyCellRows, parseCellCsv, splitCsv } from './cellCsv';
import {
  bandwidthChoices,
  carrierBandName,
  clampEtilt,
  etiltRangeFor,
  sectorBearing,
  shownEtilt,
} from './rfFields';

const CAT = [ANTENNA_ENTRY, AAU_ENTRY];

describe('etiltRangeFor', () => {
  it('is the range of the port the carrier uses, the AAU range for an AAU, null without equipment', () => {
    expect(etiltRangeFor(lteSettings('ant-a1'), CAT)).toEqual({ minDeg: 0, maxDeg: 8, stepDeg: 1 });
    const low = lteSettings('ant-a1', {
      carriers: [{ id: 'c1', tech: 'lte', band: 'B20', bandwidthMhz: 10, feederLossDb: 0 }],
    });
    // no named port: the port whose band holds 806 MHz
    expect(etiltRangeFor(low, CAT)).toEqual({ minDeg: 2, maxDeg: 10, stepDeg: 1 });
    expect(etiltRangeFor({ equipment: { kind: 'aau', aau: 'aau-x' }, carriers: [] }, CAT)).toEqual({
      minDeg: 3,
      maxDeg: 9,
      stepDeg: 1,
    });
    expect(etiltRangeFor({ carriers: [] }, CAT)).toBeNull();
  });
});

describe('clampEtilt', () => {
  const r = { minDeg: -2, maxDeg: 12, stepDeg: 2 };
  it('clamps into the range and snaps to the step from the low end', () => {
    expect(clampEtilt(20, r)).toBe(12);
    expect(clampEtilt(-9, r)).toBe(-2);
    expect(clampEtilt(4.9, r)).toBe(4);
    expect(clampEtilt(5.1, r)).toBe(6);
  });
  it('shows the job default when nothing is set (0 clamped into the range)', () => {
    expect(shownEtilt({}, { minDeg: 3, maxDeg: 9, stepDeg: 1 })).toBe(3);
    expect(shownEtilt({ etiltDeg: 30 }, { minDeg: 3, maxDeg: 9, stepDeg: 1 })).toBe(9);
  });
});

describe('band names and bandwidths', () => {
  it('names a band for the carrier tech', () => {
    expect(carrierBandName({ band: 'b3-n3', tech: 'lte' })).toBe('B3');
    expect(carrierBandName({ band: 'b3-n3', tech: 'nr' })).toBe('n3');
    expect(carrierBandName({ band: 'n78', tech: 'lte' })).toBe('n78');
  });
  it('offers NR TDD up to 100 MHz and LTE up to 20', () => {
    expect(bandwidthChoices('nr', 'n78')).toContain(100);
    expect(bandwidthChoices('nr', 'B3')).not.toContain(100);
    expect(bandwidthChoices('lte', 'B3')).toEqual([5, 10, 15, 20]);
  });
});

describe('sectorBearing', () => {
  it('is the mean true azimuth, across north', () => {
    const units = [unit('ant-a1', 350), unit('ant-a2', 10, { convergenceDeg: 0 })];
    expect(sectorBearing(['ant-a1', 'ant-a2'], units)).toBeCloseTo(0.25, 1);
    expect(sectorBearing(['ant-zz'], units)).toBeNull();
  });
});

describe('cell CSV', () => {
  it('splits quoted cells, semicolons and CRLF', () => {
    expect(splitCsv('a;b\r\n"x;1";"say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x;1', 'say "hi"'],
    ]);
  });
  it('flags cells it cannot use and a unit set twice', () => {
    const r = parseCellCsv(
      'antenna,band,bw,power,etilt,antenna_model\nA1,B99,abc,99,50,Nope\nA1,B3,20,40,2,\n',
      [{ id: 'ant-a1', name: 'A1' }],
      CAT,
    );
    if (!r.ok) throw new Error('parse');
    expect(r.rows[0]?.problems).toEqual([
      'band-unknown',
      'bandwidth',
      'power',
      'etilt',
      'antenna-model',
    ]);
    expect(r.rows[1]?.problems).toEqual(['duplicate']);
  });
});

describe('cell CSV applies equipment by the tab rule', () => {
  // a second antenna with only one high-band port, "hi2", e-tilt 0 to 8
  const OTHER = {
    ...ANTENNA_ENTRY,
    id: 'ant-y',
    model: 'P2',
    ports: [
      { ...(ANTENNA_ENTRY.kind === 'antenna' ? ANTENNA_ENTRY.ports[1] : undefined), id: 'hi2' },
    ],
  } as RfCatalogueEntry;
  const cat = [ANTENNA_ENTRY, RADIO_ENTRY, AAU_ENTRY, OTHER];
  const units = [{ id: 'ant-a1', name: 'A1' }];
  const apply = (csv: string, settings = [lteSettings('ant-a1')]) => {
    const r = parseCellCsv(csv, units, cat);
    if (!r.ok) throw new Error('parse');
    return applyCellRows(sectorsFile([], settings), r.rows, cat).antennas[0];
  };

  it('an AAU strips the radio and port and clamps the e-tilt to the AAU range', () => {
    const s = apply('antenna,etilt_deg,radio_model\nA1,20,Maker A1\n');
    expect(s?.equipment).toEqual({ kind: 'aau', aau: 'aau-x' });
    expect(s?.carriers[0]?.port).toBeUndefined();
    expect(s?.carriers[0]?.radioUnit).toBeUndefined();
    expect(s?.etiltDeg).toBe(9);
  });

  it('a new antenna keeps the radio, drops a port it lacks and clamps the e-tilt', () => {
    const s = apply('antenna,etilt_deg,antenna_model\nA1,30,Maker P2\n');
    expect(s?.equipment).toEqual({ kind: 'separate', antenna: 'ant-y', radio: 'rru-x' });
    // the old carrier named port "high", which P2 does not have
    expect(s?.carriers[0]?.port).toBeUndefined();
    expect(s?.etiltDeg).toBe(8);
  });

  it('clamps an imported e-tilt even when the equipment stays', () => {
    expect(apply('antenna,etilt_deg\nA1,-15\n')?.etiltDeg).toBe(0);
    expect(apply('antenna,etilt_deg\nA1,5.4\n')?.etiltDeg).toBe(5);
  });

  it('gives a new NR carrier a bandwidth its band allows (FDD n3: 50 MHz, not 100)', () => {
    const s = apply('antenna,band\nA1,n3\n', []);
    expect(s?.carriers[0]).toMatchObject({ tech: 'nr', band: 'n3', bandwidthMhz: 50 });
    expect(apply('antenna,band\nA1,n78\n', [])?.carriers[0]?.bandwidthMhz).toBe(100);
  });
});
