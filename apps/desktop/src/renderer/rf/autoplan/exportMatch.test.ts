import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AntennaUnit, RfCatalogueEntry, RfSector } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { matchCellExport, type ExportMatch } from './exportMatch';

const CATALOGUE = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../../../../packages/rf/catalogue/generic.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { entries: RfCatalogueEntry[] }
).entries;

const val = (value: number) => ({ value, basis: 'measured', quality: { basis: 'measured' } });

function unit(id: string, name: string, az: number, heightM = 25): AntennaUnit {
  return {
    id,
    name,
    kind: 'panel',
    status: 'accepted',
    azimuthGridDeg: val(az),
    convergenceDeg: 0,
    heightM: val(heightM),
    widthM: val(0.3),
    depthM: val(0.1),
  } as unknown as AntennaUnit;
}

const sec = (id: string, name: string, antennaIds: string[]): RfSector => ({
  id,
  name,
  antennaIds,
});

function ok(r: ReturnType<typeof matchCellExport>): ExportMatch {
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('matchCellExport', () => {
  it('reports an empty file and a missing antenna column', () => {
    expect(matchCellExport('', [], [], CATALOGUE)).toEqual({ error: 'empty' });
    expect(matchCellExport('band\nB3', [], [], CATALOGUE)).toEqual({ error: 'no-antenna-column' });
  });

  it('matches by exact unit name first', () => {
    const units = [unit('u1', 'Panel A', 10), unit('u2', 'Panel B', 130)];
    const m = ok(
      matchCellExport('antenna,band\nPanel A,B3', units, [sec('sec-s1', 'S1', ['u1'])], CATALOGUE),
    );
    expect(m.picks.get('u1')).toHaveLength(1);
    expect(m.picks.get('u1')?.[0]).toMatchObject({ by: 'export', confidence: 'high' });
  });

  it('matches by sector name plus nearest bearing when the name does not match', () => {
    const units = [unit('u1', 'P1', 118), unit('u2', 'P2', 125)];
    const sectors = [sec('sec-s2', 'S2', ['u1', 'u2'])];
    const m = ok(
      matchCellExport('antenna,sector,azimuth,band\nX-17,S2,120,B3', units, sectors, CATALOGUE),
    );
    expect([...m.picks.keys()]).toEqual(['u1']);
    expect(m.picks.get('u1')?.[0]?.confidence).toBe('medium');
  });

  it('breaks a bearing tie by height', () => {
    const units = [unit('u1', 'P1', 120, 25), unit('u2', 'P2', 120, 30)];
    const sectors = [sec('sec-s1', 'S1', ['u1', 'u2'])];
    const m = ok(
      matchCellExport('antenna,sector,azimuth,height\nX,S1,120,30', units, sectors, CATALOGUE),
    );
    expect([...m.picks.keys()]).toEqual(['u2']);
  });

  it('keeps two rows for one antenna as two carriers', () => {
    const units = [unit('u1', 'Panel A', 10)];
    const m = ok(
      matchCellExport(
        'antenna,band,bandwidth_mhz,power_dbm\nPanel A,B3,10,40\nPanel A,n78,,43',
        units,
        [],
        CATALOGUE,
      ),
    );
    const picks = m.picks.get('u1') ?? [];
    expect(picks.map((p) => p.carrier.band)).toEqual(['B3', 'n78']);
    expect(picks.map((p) => p.carrier.tech)).toEqual(['lte', 'nr']);
    expect(picks[0]?.carrier).toMatchObject({ bandwidthMhz: 10, powerDbmPerPort: 40 });
    expect(picks[1]?.carrier.bandwidthMhz).toBeGreaterThan(0);
  });

  it('lists rows and units that do not match', () => {
    const units = [
      unit('u1', 'Panel A', 10),
      unit('u2', 'Panel B', 130),
      unit('u3', 'Panel C', 250),
    ];
    const csv = 'antenna,band\nPanel A,B3\nPanel B,B3\nNobody,B3';
    const m = ok(matchCellExport(csv, units, [], CATALOGUE));
    expect(m.unmatchedRows).toEqual([4]);
    expect(m.unmatchedUnits).toEqual(['u3']);
  });

  it('renames a matched sector but never moves a unit', () => {
    const units = [unit('u1', 'Panel A', 10), unit('u2', 'Panel B', 130)];
    const sectors = [sec('sec-s1', 'S1', ['u1']), sec('sec-s2', 'S2', ['u2'])];
    const m = ok(matchCellExport('antenna,sector\nPanel A,Alpha', units, sectors, CATALOGUE));
    expect(m.renames).toEqual([{ sectorId: 'sec-s1', name: 'Alpha' }]);
  });

  it('resolves model text through the catalogue, else falls back to the rules with low confidence', () => {
    const units = [unit('u1', 'Panel A', 10), unit('u2', 'Panel B', 130)];
    const csv =
      'antenna,band,radio_model\nPanel A,n78,generic-aau-64t64r-n78\nPanel B,B3,No Such Model';
    const m = ok(matchCellExport(csv, units, [], CATALOGUE));
    expect(m.picks.get('u1')?.[0]).toMatchObject({
      equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
      confidence: 'high',
    });
    const low = m.picks.get('u2')?.[0];
    expect(low?.confidence).toBe('low');
    expect(low?.reason).toMatch(/not found in the catalogue/);
    expect(low?.equipment.kind).toBe('separate');
    expect(low?.carrier.band).toBe('B3');
  });

  it('takes band, tech and bandwidth from the rules when the row has no band', () => {
    const m = ok(matchCellExport('antenna\nPanel A', [unit('u1', 'Panel A', 10)], [], CATALOGUE));
    expect(m.picks.get('u1')?.[0]?.carrier).toMatchObject({ band: 'B3', tech: 'lte' });
  });
});
