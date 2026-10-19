import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RfCatalogueEntry as CatalogueEntrySchema,
  RfSectorsFile,
  splitRfOrigins,
  type AntennaUnit,
  type RfAntennaSettings,
  type RfCarrier,
  type RfCatalogueEntry,
  type RfOrigin,
} from '@aio/schema';
import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { sectorsFile, unit } from '../__fixtures__/rfData';
import {
  applyToFile,
  buildProposal,
  NO_CARRIER_FITS,
  validateAiPick,
  type AiPickRaw,
} from './proposal';
import { planText, raw as rawText, type PlanText } from './planText';
import type { PlanPick } from './types';

/** The English the review shows for these parts. */
const en = (parts: readonly PlanText[] | undefined): string => planText(t, parts ?? []);

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
  reason: [rawText('Cell export row')],
});

describe('validateAiPick', () => {
  it('accepts a valid AAU pick as an AI pick', () => {
    const p = validateAiPick(raw, unitDeep, CATALOGUE);
    expect(p).toEqual({
      equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
      carrier: { band: 'n78', tech: 'nr', bandwidthMhz: 100 },
      by: 'ai',
      confidence: 'high',
      reason: [{ text: 'Deep wide face, AAU' }],
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
    expect(en(p.reason)).toMatch(/^AI pick not usable: /);
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
    expect(en(p.reason)).toMatch(/^AI pick not usable: /);
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
    expect(RfSectorsFile.safeParse(splitRfOrigins(out).file).success).toBe(true);
  });
  it('keeps the equipment when a kept carrier does not fit the new one (R11 d)', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }, { by: 'ai' }] });
    const before = settingsOf(file, 'ant-u1');
    const ai = validateAiPick(raw, unitDeep, CATALOGUE);
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [ai]]]),
    });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.equipment).toBeUndefined();
    expect(en(row?.note)).toMatch(/^Kept your equipment: your B1 carrier doesn't fit /);
    // A carrier is kept, so the AI adds none (R11 b).
    expect(row?.picks).toEqual([]);
    const s = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s?.equipment).toEqual(before?.equipment);
    expect(s?.origins?.equipment).toEqual({ by: 'ai' });
    expect(s?.carriers).toEqual([before?.carriers[0]]);
  });
  it('adds no AI or rules carrier when one is kept, but still replaces the equipment (R11 b)', () => {
    const file = fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }] });
    const panel = validateAiPick(
      {
        ...raw,
        entryId: 'generic-panel-65-17',
        radioId: 'generic-rru-4t4r-4x40w',
        band: 'B3',
        tech: 'lte',
        bandwidthMhz: 20,
      },
      unitDeep,
      CATALOGUE,
    );
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [panel]]]),
    });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.picks).toEqual([]);
    expect(row?.equipment?.equipment).toEqual(panel.equipment);
    const s = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s?.equipment).toEqual(panel.equipment);
    expect(s?.carriers.map((c) => [c.id, c.band, c.origin?.by ?? 'user'])).toEqual([
      ['c1', 'B1', 'user'],
    ]);
  });
  it('replaces a new carrier the kept equipment cannot do with one it can (R11 e)', () => {
    const file = fileWith({ carriers: [] });
    const own = file.antennas[0];
    if (own) own.equipment = { kind: 'aau', aau: 'generic-aau-64t64r-n78' };
    // The thin face makes the rules pick B3 on a panel; the person's AAU only does n78.
    const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.equipment).toBeUndefined();
    expect(row?.picks).toHaveLength(1);
    expect(row?.picks[0]).toMatchObject({
      carrier: { tech: 'nr', band: 'n78', bandwidthMhz: 100 },
      confidence: 'low',
    });
    expect(en(row?.picks[0]?.reason)).toMatch(/^B3 doesn't fit .*, so n78\.$/);
    const s = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s?.carriers).toEqual([
      {
        id: 'c1',
        tech: 'nr',
        band: 'n78',
        bandwidthMhz: 100,
        feederLossDb: 0,
        origin: { by: 'rules', confidence: 'low' },
      },
    ]);
  });
  it('writes no carrier when nothing fits the kept equipment (R11 e)', () => {
    const lowOnly = CatalogueEntrySchema.parse({
      kind: 'antenna',
      id: 'low-only',
      vendor: 'Maker',
      model: 'Low band panel',
      source: 'user',
      verified: false,
      ports: [
        {
          id: 'p1',
          bandRangeMhz: [698, 960],
          gainDbi: 15,
          hBeamwidthDeg: 65,
          vBeamwidthDeg: 12,
          frontToBackDb: 28,
          etilt: { minDeg: 0, maxDeg: 10, stepDeg: 1 },
          patterns: [],
        },
      ],
    });
    const catalogue = [...CATALOGUE, lowOnly];
    const file = fileWith({ carriers: [] });
    const own = file.antennas[0];
    if (own) own.equipment = { kind: 'separate', antenna: 'low-only' };
    const p = buildProposal({ units, file, catalogue, picks: new Map() });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.picks).toEqual([]);
    expect(row?.note).toEqual([NO_CARRIER_FITS]);
    expect(settingsOf(applyToFile(file, p, catalogue), 'ant-u1')?.carriers).toEqual([]);
  });
  it('flags an export band its own equipment cannot do (R10, R11 f)', () => {
    // The kept AAU does n78, so the export's n78 carrier stays, but its panel could not do it.
    const file = fileWith({ carriers: [] });
    const own = file.antennas[0];
    if (own) own.equipment = { kind: 'aau', aau: 'generic-aau-64t64r-n78' };
    const n78 = {
      ...exportPick('n78'),
      carrier: { tech: 'nr' as const, band: 'n78', bandwidthMhz: 100 },
    };
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([
        ['ant-u1', [n78]],
        ['ant-u2', [n78]],
      ]),
    });
    const r1 = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(r1?.picks[0]).toMatchObject({ carrier: { band: 'n78' }, confidence: 'low' });
    expect(en(r1?.picks[0]?.reason)).toMatch(/^n78 doesn't fit .* from the export/);
    // Without kept equipment the export's own panel is written, and it can do B3 instead.
    const r2 = p.rows.find((r) => r.unitId === 'ant-u2');
    expect(r2?.equipment?.equipment.kind).toBe('separate');
    expect(r2?.picks[0]).toMatchObject({ carrier: { band: 'B3' }, confidence: 'low' });
  });
  it('flags an export radio the catalogue does not have (R11 h)', () => {
    const pick: PlanPick = {
      ...exportPick('B3'),
      equipment: { kind: 'separate', antenna: 'generic-panel-65-17', radio: 'mystery-rru' },
    };
    const p = buildProposal({
      units,
      file: emptyFile,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [pick]]]),
    });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.equipment?.confidence).toBe('low');
    expect(en(row?.equipment?.reason)).toMatch(/mystery-rru/);
    const s = settingsOf(applyToFile(emptyFile, p, CATALOGUE), 'ant-u1');
    expect(s?.equipment).toEqual({ kind: 'separate', antenna: 'generic-panel-65-17' });
    expect(s?.carriers[0]?.radioUnit).toBeUndefined();
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

    // Kept carriers come first, unchanged; export bands they already have are not added (R11 c).
    const file = fileWith({ carriers: [{ by: 'user' }] });
    const kept = file.antennas[0]?.carriers[0];
    if (kept) kept.id = 'c2';
    const p2 = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [exportPick('B1'), exportPick('B3'), exportPick('B3')]]]),
    });
    expect(p2.rows[0]?.picks.map((p) => p.carrier.band)).toEqual(['B3']);
    const out2 = applyToFile(file, p2, CATALOGUE);
    expect(settingsOf(out2, 'ant-u1')?.carriers.map((c) => [c.id, c.band])).toEqual([
      ['c2', 'B1'],
      ['c1', 'B3'],
    ]);
    expect(settingsOf(out2, 'ant-u1')?.carriers[0]).toEqual(kept);
    expect(RfSectorsFile.safeParse(splitRfOrigins(out2).file).success).toBe(true);
  });
  it('writes exactly the kept carriers plus the row picks for every row (R11 g)', () => {
    const scenarios: { file: RfSectorsFile; picks: Map<string, PlanPick[]> }[] = [
      { file: emptyFile, picks: new Map() },
      {
        file: fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }, { by: 'ai' }] }),
        picks: new Map(),
      },
      {
        file: fileWith({ equipment: { by: 'ai' }, carriers: [{ by: 'user' }] }),
        picks: new Map([['ant-u1', [validateAiPick(raw, unitDeep, CATALOGUE)]]]),
      },
      {
        file: fileWith({ carriers: [{ by: 'export' }, { by: 'rules' }] }),
        picks: new Map([
          ['ant-u1', [exportPick('B1'), exportPick('B3'), exportPick('B20')]],
          ['ant-u2', [exportPick('B3'), exportPick('B1')]],
        ]),
      },
    ];
    for (const { file, picks } of scenarios) {
      const p = buildProposal({ units, file, catalogue: CATALOGUE, picks });
      const out = applyToFile(file, p, CATALOGUE);
      expect(RfSectorsFile.safeParse(splitRfOrigins(out).file).success).toBe(true);
      for (const row of p.rows) {
        const before = settingsOf(file, row.unitId)?.carriers ?? [];
        const keptBefore = before.filter((_, k) => row.kept.carriers[k] === true);
        const written = settingsOf(out, row.unitId)?.carriers ?? [];
        const summary = (c: Pick<RfCarrier, 'tech' | 'band' | 'bandwidthMhz'>) => [
          c.tech,
          c.band,
          c.bandwidthMhz,
        ];
        expect(written.map(summary)).toEqual([
          ...keptBefore.map(summary),
          ...row.picks.map((pk) => summary(pk.carrier)),
        ]);
        expect(written.slice(keptBefore.length).map((c) => c.origin)).toEqual(
          row.picks.map((pk) => ({ by: pk.by, confidence: pk.confidence })),
        );
        expect(written.slice(keptBefore.length).map((c) => c.radioUnit)).toEqual(
          row.picks.map((pk) => pk.carrier.radioUnit),
        );
      }
    }
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
    expect(RfSectorsFile.safeParse(splitRfOrigins(out).file).success).toBe(true);
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

describe('a value the person cleared', () => {
  /** u1 with its equipment and e-tilt cleared by hand: origin user, value absent. */
  const cleared = (keys: ('equipment' | 'etiltDeg')[]): RfSectorsFile => {
    const file = fileWith({ carriers: [] });
    const s = file.antennas[0];
    if (!s) throw new Error('no settings');
    if (keys.includes('equipment')) delete s.equipment;
    s.origins = Object.fromEntries(keys.map((k) => [k, { by: 'user' as const }]));
    return file;
  };

  it('is not filled again by Auto-plan or Re-plan: no equipment, no carrier', () => {
    const file = cleared(['equipment']);
    const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
    const row = p.rows.find((r) => r.unitId === 'ant-u1');
    expect(row?.kept.equipment).toBe(true);
    expect(row?.equipment).toBeUndefined();
    expect(row?.picks).toEqual([]);
    expect(row?.note).toEqual([{ key: 'rf.autoplan.note.clearedEquipment' }]);
    const s = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s?.equipment).toBeUndefined();
    expect(s?.carriers).toEqual([]);
    expect(s?.origins?.equipment).toEqual({ by: 'user' });
    // the other units are planned as before
    expect(p.rows.find((r) => r.unitId === 'ant-u2')?.equipment).toBeDefined();
  });

  it('keeps a cleared e-tilt empty against a cell export', () => {
    const file = cleared(['etiltDeg']);
    const p = buildProposal({
      units,
      file,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [{ ...exportPick('B3'), etiltDeg: 6 }]]]),
    });
    expect(p.rows[0]?.kept.etiltDeg).toBe(true);
    expect(p.rows[0]?.etilt).toBeUndefined();
    const s = settingsOf(applyToFile(file, p, CATALOGUE), 'ant-u1');
    expect(s?.etiltDeg).toBeUndefined();
    expect(s?.origins?.etiltDeg).toEqual({ by: 'user' });
  });

  it('a value never set (no origin) is still planned', () => {
    const file = fileWith({ carriers: [] });
    delete file.antennas[0]?.equipment;
    const p = buildProposal({ units, file, catalogue: CATALOGUE, picks: new Map() });
    expect(p.rows[0]?.kept.equipment).toBe(false);
    expect(p.rows[0]?.equipment).toBeDefined();
  });
});

describe('the planner holds no English', () => {
  it('reasons and notes are message keys with values', () => {
    const p = validateAiPick({ ...raw, entryId: 'nope' }, unitDeep, CATALOGUE);
    expect(p.reason[0]).toEqual({
      key: 'rf.autoplan.reason.aiUnusable',
      vars: { problem: { key: 'rf.autoplan.aiProblem.notInCatalogue', vars: { id: 'nope' } } },
    });
    const proposal = buildProposal({
      units,
      file: emptyFile,
      catalogue: CATALOGUE,
      picks: new Map([['ant-u1', [p]]]),
    });
    const parts = proposal.rows.flatMap((r) => [
      ...r.picks.flatMap((x) => x.reason),
      ...(r.note ?? []),
    ]);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((x) => 'key' in x && x.key.startsWith('rf.autoplan.'))).toBe(true);
  });

  it('the AI reason is kept as the AI wrote it', () => {
    expect(validateAiPick(raw, unitDeep, CATALOGUE).reason).toEqual([
      { text: 'Deep wide face, AAU' },
    ]);
  });
});
