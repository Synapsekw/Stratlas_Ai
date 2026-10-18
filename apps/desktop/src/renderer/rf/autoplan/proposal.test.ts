import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RfSectorsFile,
  type AntennaUnit,
  type RfAntennaSettings,
  type RfCarrier,
  type RfCatalogueEntry,
  type RfOrigin,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sectorsFile, unit } from '../__fixtures__/rfData';
import { applyToFile, buildProposal, validateAiPick, type AiPickRaw } from './proposal';
import type { PlanPick } from './types';

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

const measured = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const },
});

const unitDeep = unit('ant-u1', 0, { widthM: measured(0.5), depthM: measured(0.2) });
const units: AntennaUnit[] = [unit('ant-u1', 0), unit('ant-u2', 120), unit('ant-u3', 240)];

const raw: AiPickRaw = {
  unitId: 'ant-u1',
  entryId: 'generic-aau-64t64r-n78',
  band: 'n78',
  tech: 'nr',
  bandwidthMhz: 100,
  reason: 'Deep wide face, AAU',
  confidence: 'high',
};

const emptyFile = sectorsFile([], []);

/** A file with u1..u3 in one sector each and u1's settings carrying the given origins. */
function fileWith(o: { equipment?: RfOrigin; carriers: (RfOrigin | undefined)[] }): RfSectorsFile {
  const settings: RfAntennaSettings = {
    antennaId: 'ant-u1',
    equipment: {
      kind: 'separate',
      antenna: 'generic-panel-65-18',
      radio: 'generic-rru-4t4r-4x60w',
    },
    active: true,
    carriers: o.carriers.map((origin, i): RfCarrier => ({
      id: `c${String(i + 1)}`,
      tech: 'lte',
      band: 'B1',
      bandwidthMhz: 15,
      radioUnit: 'generic-rru-4t4r-4x60w',
      feederLossDb: 1,
      ...(origin ? { origin } : {}),
    })),
    ...(o.equipment ? { origins: { equipment: o.equipment } } : {}),
  };
  return sectorsFile(
    [
      { id: 'sec-a', antennaIds: ['ant-u1'] },
      { id: 'sec-b', antennaIds: ['ant-u2'] },
      { id: 'sec-c', antennaIds: ['ant-u3'] },
    ],
    [settings],
  );
}

const settingsOf = (f: RfSectorsFile, id: string) => f.antennas.find((a) => a.antennaId === id);

const exportPick = (band: string): PlanPick => ({
  equipment: {
    kind: 'separate',
    antenna: 'generic-panel-65-17',
    radio: 'generic-rru-4t4r-4x40w',
  },
  carrier: { tech: 'lte', band, bandwidthMhz: 20, radioUnit: 'generic-rru-4t4r-4x40w' },
  by: 'export',
  confidence: 'high',
  reason: 'Cell export row',
});

describe('validateAiPick', () => {
  it('accepts a valid AAU pick as an AI pick', () => {
    const p = validateAiPick(raw, unitDeep, CATALOGUE);
    expect(p).toEqual({
      equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
      carrier: { band: 'n78', tech: 'nr', bandwidthMhz: 100 },
      by: 'ai',
      confidence: 'high',
      reason: 'Deep wide face, AAU',
    });
  });
  it('accepts a panel with a radio on a band both can do', () => {
    const p = validateAiPick(
      {
        ...raw,
        entryId: 'generic-panel-65-17',
        radioId: 'generic-rru-4t4r-4x40w',
        band: 'B3',
        tech: 'lte',
        bandwidthMhz: 20,
        confidence: 'medium',
      },
      unitDeep,
      CATALOGUE,
    );
    expect(p.equipment).toEqual({
      kind: 'separate',
      antenna: 'generic-panel-65-17',
      radio: 'generic-rru-4t4r-4x40w',
    });
    expect(p.carrier).toEqual({
      band: 'B3',
      tech: 'lte',
      bandwidthMhz: 20,
      radioUnit: 'generic-rru-4t4r-4x40w',
    });
    expect(p).toMatchObject({ by: 'ai', confidence: 'medium' });
  });
  it('accepts a panel without a radio', () => {
    const p = validateAiPick(
      { ...raw, entryId: 'generic-panel-65-17', band: 'B3', tech: 'lte', bandwidthMhz: 20 },
      unitDeep,
      CATALOGUE,
    );
    expect(p.equipment).toEqual({ kind: 'separate', antenna: 'generic-panel-65-17' });
    expect(p.carrier).toEqual({ band: 'B3', tech: 'lte', bandwidthMhz: 20 });
    expect(p.by).toBe('ai');
  });
  it('replaces an unknown AI entry id with the rules pick at low confidence', () => {
    const p = validateAiPick({ ...raw, entryId: 'nope' }, unitDeep, CATALOGUE);
    expect(p).toMatchObject({ by: 'rules', confidence: 'low' });
    expect(p.equipment).toEqual({ kind: 'aau', aau: 'generic-aau-64t64r-n78' });
    expect(p.reason).toMatch(/^AI pick not usable: /);
  });
  it('rejects a band the equipment cannot do', () => {
    expect(
      validateAiPick({ ...raw, entryId: 'generic-aau-64t64r-n78', band: 'B3' }, unitDeep, CATALOGUE)
        .confidence,
    ).toBe('low');
  });
  it.each<[string, Partial<AiPickRaw>]>([
    ['an AAU paired with a radio', { radioId: 'generic-rru-4t4r-4x40w' }],
    ['a radio as the entry', { entryId: 'generic-rru-4t4r-4x40w', band: 'B3', tech: 'lte' }],
    [
      'a radio id that names an antenna',
      { entryId: 'generic-panel-65-17', radioId: 'generic-panel-65-18', band: 'B3', tech: 'lte' },
    ],
    [
      'an unknown radio id',
      { entryId: 'generic-panel-65-17', radioId: 'nope', band: 'B3', tech: 'lte' },
    ],
    [
      'a band the radio cannot do',
      {
        entryId: 'generic-panel-65-15',
        radioId: 'generic-rru-4t4r-4x40w',
        band: 'n28',
        tech: 'nr',
        bandwidthMhz: 20,
      },
    ],
    ['an unknown band', { band: 'n999' }],
    ['a tech the band has no layer for', { tech: 'lte' }],
    ['a bandwidth the band does not offer', { bandwidthMhz: 7 }],
    ['another unit', { unitId: 'ant-u9' }],
  ])('falls back to the rules for %s', (_why, over) => {
    const p = validateAiPick({ ...raw, ...over }, unitDeep, CATALOGUE);
    expect(p).toMatchObject({ by: 'rules', confidence: 'low' });
    expect(p.reason).toMatch(/^AI pick not usable: /);
  });
});

describe('buildProposal', () => {
  it('plans sectors by bearing and gives units without a pick the rules pick', () => {
    const p = buildProposal({ units, file: emptyFile, catalogue: CATALOGUE, picks: new Map() });
    expect(p.regrouped).toBe(true);
    expect(p.rows.map((r) => r.unitId)).toEqual(['ant-u1', 'ant-u2', 'ant-u3']);
    expect(p.rows.every((r) => p.sectors.some((s) => s.id === r.sectorId))).toBe(true);
    expect(p.rows[0]?.picks).toHaveLength(1);
    expect(p.rows[0]?.picks[0]).toMatchObject({ by: 'rules', confidence: 'medium' });
    expect(p.rows[0]?.kept).toEqual({ equipment: false, etiltDeg: false, carriers: [] });
    expect(p.renames).toEqual([]);
    expect(p.unmatchedRows).toEqual([]);
  });
  it('uses the given picks and lists left-out units', () => {
    const ai: PlanPick = validateAiPick(raw, unitDeep, CATALOGUE);
    const draft = unit('ant-d1', 60, { status: 'draft' });
    const p = buildProposal({
      units: [...units, draft],
      file: emptyFile,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [ai]]]),
    });
    expect(p.rows.find((r) => r.unitId === 'ant-u1')?.picks).toEqual([ai]);
    expect(p.rows.some((r) => r.unitId === 'ant-d1')).toBe(false);
    expect(p.leftOut).toEqual([{ unitId: 'ant-d1', reason: 'draft' }]);
  });
  it('keeps user and export groups on re-plan', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }] });
    const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
    expect(p.rows.find((r) => r.unitId === 'ant-u1')?.kept).toEqual({
      equipment: false,
      etiltDeg: false,
      carriers: [true],
    });
    const out = applyToFile(file, p, CATALOGUE);
    expect(settingsOf(out, 'ant-u1')?.carriers[0]?.bandwidthMhz).toBe(
      file.antennas[0]?.carriers[0]?.bandwidthMhz,
    );
  });
  it('counts a missing origin as user and keeps export groups', () => {
    const file = fileWith({ carriers: [undefined, { by: 'export' }, { by: 'rules' }] });
    const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
    expect(p.rows.find((r) => r.unitId === 'ant-u1')?.kept).toEqual({
      equipment: true,
      etiltDeg: false,
      carriers: [true, true, false],
    });
  });
  it('keeps the existing sectors and passes renames of known sectors only', () => {
    const file = fileWith({ carriers: [] });
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map(),
      renames: [
        { sectorId: 'sec-b', name: 'East' },
        { sectorId: 'sec-zz', name: 'Ghost' },
      ],
      unmatchedRows: [4, 7],
    });
    expect(p.regrouped).toBe(false);
    expect(p.sectors).toEqual(file.sectors);
    expect(p.renames).toEqual([{ sectorId: 'sec-b', name: 'East' }]);
    expect(p.unmatchedRows).toEqual([4, 7]);
  });
});

describe('applyToFile', () => {
  it('writes origins on applied groups', () => {
    const out = applyToFile(
      emptyFile,
      buildProposal({ units, file: emptyFile, catalogue: CATALOGUE, picks: new Map() }),
      CATALOGUE,
    );
    expect(out.antennas[0]?.origins?.equipment).toEqual({ by: 'rules', confidence: 'medium' });
    expect(out.antennas[0]?.carriers[0]?.origin?.by).toBe('rules');
    expect(out.antennas[0]?.carriers[0]).toEqual({
      id: 'c1',
      tech: 'lte',
      band: 'B3',
      bandwidthMhz: 20,
      radioUnit: 'generic-rru-4t4r-4x40w',
      feederLossDb: 0,
      origin: { by: 'rules', confidence: 'medium' },
    });
    expect(out.antennas[0]?.equipment).toEqual({
      kind: 'separate',
      antenna: 'generic-panel-65-17',
      radio: 'generic-rru-4t4r-4x40w',
    });
    expect(out.sectors.flatMap((s) => s.antennaIds).sort()).toEqual(['ant-u1', 'ant-u2', 'ant-u3']);
  });
  it('the result passes RfSectorsFile.parse', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }, { by: 'ai' }] });
    const out = applyToFile(
      file,
      buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() }),
      CATALOGUE,
    );
    expect(RfSectorsFile.safeParse(out).success).toBe(true);
  });
  it('replaces ai equipment, keeps a user carrier and drops a replaced ai carrier', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }, { by: 'ai' }] });
    const ai = validateAiPick(raw, unitDeep, CATALOGUE);
    const out = applyToFile(
      file,
      buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map([['ant-u1', [ai]]]) }),
      CATALOGUE,
    );
    const s = settingsOf(out, 'ant-u1');
    expect(s?.equipment).toEqual({ kind: 'aau', aau: 'generic-aau-64t64r-n78' });
    expect(s?.origins?.equipment).toEqual({ by: 'ai', confidence: 'high' });
    // The kept carrier stays the person's, but an AAU names no radio.
    expect(s?.carriers).toHaveLength(1);
    expect(s?.carriers[0]).toMatchObject({
      id: 'c1',
      band: 'B1',
      bandwidthMhz: 15,
      feederLossDb: 1,
    });
    expect(s?.carriers[0]?.radioUnit).toBeUndefined();
    expect(RfSectorsFile.safeParse(out).success).toBe(true);
  });
  it('keeps user equipment and names its radio on a replaced carrier', () => {
    const file = fileWith({ carriers: [{ by: 'rules' }] });
    const before = settingsOf(file, 'ant-u1');
    const out = applyToFile(
      file,
      buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() }),
      CATALOGUE,
    );
    const s = settingsOf(out, 'ant-u1');
    expect(s?.equipment).toEqual(before?.equipment);
    expect(s?.origins?.equipment).toBeUndefined();
    expect(s?.carriers).toEqual([
      {
        id: 'c1',
        tech: 'lte',
        band: 'B3',
        bandwidthMhz: 20,
        radioUnit: 'generic-rru-4t4r-4x60w',
        feederLossDb: 0,
        origin: { by: 'rules', confidence: 'medium' },
      },
    ]);
  });
  it('gives several picks carriers c1, c2 and skips ids a kept carrier holds', () => {
    const out = applyToFile(
      emptyFile,
      buildProposal({
        units,
        file: emptyFile,
        catalogue: CATALOGUE,
        picks: new Map([['ant-u2', [exportPick('B3'), exportPick('B1')]]]),
      }),
      CATALOGUE,
    );
    expect(settingsOf(out, 'ant-u2')?.carriers.map((c) => [c.id, c.band, c.origin?.by])).toEqual([
      ['c1', 'B3', 'export'],
      ['c2', 'B1', 'export'],
    ]);

    const file = fileWith({ carriers: [{ by: 'user' }] });
    const kept = file.antennas[0]?.carriers[0];
    if (kept) kept.id = 'c2';
    const out2 = applyToFile(
      file,
      buildProposal({
        units,
        file,
        catalogue: CATALOGUE,
        picks: new Map([['ant-u1', [exportPick('B3'), exportPick('B20')]]]),
      }),
      CATALOGUE,
    );
    expect(settingsOf(out2, 'ant-u1')?.carriers.map((c) => [c.id, c.band])).toEqual([
      ['c2', 'B1'],
      ['c1', 'B20'],
    ]);
    expect(RfSectorsFile.safeParse(out2).success).toBe(true);
  });
  it('writes a cell export e-tilt clamped to the equipment, unless the person set one', () => {
    const tilted = { ...exportPick('B3'), etiltDeg: 99 };
    const out = applyToFile(
      emptyFile,
      buildProposal({
        units,
        file: emptyFile,
        catalogue: CATALOGUE,
        picks: new Map([['ant-u2', [tilted]]]),
      }),
      CATALOGUE,
    );
    const s = settingsOf(out, 'ant-u2');
    const port = CATALOGUE.find((e) => e.id === 'generic-panel-65-17');
    const max = port?.kind === 'antenna' ? port.ports[0]?.etilt.maxDeg : undefined;
    expect(max).toBeDefined();
    expect(s?.etiltDeg).toBe(max);
    expect(s?.origins?.etiltDeg).toEqual({ by: 'export', confidence: 'high' });
    expect(settingsOf(out, 'ant-u1')?.etiltDeg).toBeUndefined();

    const file = fileWith({ carriers: [] });
    const own = file.antennas[0];
    if (own) own.etiltDeg = 3;
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [{ ...exportPick('B3'), etiltDeg: 6 }]]]),
    });
    expect(p.rows[0]?.kept.etiltDeg).toBe(true);
    const s2 = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s2?.etiltDeg).toBe(3);
    expect(s2?.origins?.etiltDeg).toBeUndefined();
  });
  it('applies renames, never moves units and leaves orphan settings untouched', () => {
    const file = fileWith({ carriers: [] });
    const orphan: RfAntennaSettings = {
      antennaId: 'ant-gone',
      active: false,
      carriers: [
        {
          id: 'c1',
          tech: 'nr',
          band: 'n78',
          bandwidthMhz: 100,
          feederLossDb: 0,
          origin: { by: 'ai' },
        },
      ],
      origins: { equipment: { by: 'ai' } },
    };
    file.antennas.push(orphan);
    file.sectors[0]?.antennaIds.push('ant-gone');
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map(),
      renames: [{ sectorId: 'sec-b', name: 'East' }],
    });
    expect(p.rows.map((r) => r.unitId)).toEqual(['ant-u1', 'ant-u2', 'ant-u3']);
    const out = applyToFile(file, p, CATALOGUE);
    expect(out.sectors.map((s) => [s.id, s.name, s.antennaIds])).toEqual([
      ['sec-a', 'S1', ['ant-u1', 'ant-gone']],
      ['sec-b', 'East', ['ant-u2']],
      ['sec-c', 'S3', ['ant-u3']],
    ]);
    expect(settingsOf(out, 'ant-gone')).toEqual(orphan);
    expect(file.sectors[1]?.name).toBe('S2');
    expect(RfSectorsFile.safeParse(out).success).toBe(true);
  });
  it('does not mutate the input file', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'ai' }] });
    const copy = structuredClone(file);
    applyToFile(
      file,
      buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() }),
      CATALOGUE,
    );
    expect(file).toEqual(copy);
  });
});
