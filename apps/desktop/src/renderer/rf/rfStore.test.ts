// @vitest-environment jsdom
import { RF_COVERAGE_MIN_PACK, RfSectorsFile, type AntennasFile } from '@aio/schema';
import { buildProposal } from './autoplan/proposal';
import type { CellRow } from './cellCsv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AAU_ENTRY,
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  antennasFile,
  lteSettings,
  sectorsFile,
  unit,
} from './__fixtures__/rfData';
import {
  addSector,
  applyCellImport,
  applyPlan,
  applyProposal,
  deleteSector,
  loadRf,
  moveUnit,
  patchSettings,
  patchStudy,
  reassignOrphanEntry,
  removeOrphanEntry,
  renameSector,
  resetRf,
  rfStore,
  saveRf,
  selectRun,
  clearSetting,
  setEquipment,
  setHeightOverride,
  setIncludeUnreviewed,
  setPackStatus,
  setRunning,
  setDsmGroundProvider,
} from './rfStore';

type Call = [string, Record<string, unknown>];

const h = vi.hoisted(() => ({
  antennas: null as AntennasFile | null,
  sectors: null as RfSectorsFile | null,
  origins: undefined as Record<string, unknown> | undefined,
  readOnly: false,
  calls: [] as Call[],
  writeError: null as string | null,
  writeWarnings: undefined as string[] | undefined,
  delay: null as null | Promise<void>,
  writeDelay: null as null | Promise<void>,
}));

vi.mock('../shell', () => ({
  bridge: {
    call: vi.fn(async (channel: string, req: Record<string, unknown>) => {
      h.calls.push([channel, req]);
      switch (channel) {
        case 'telecom:readAntennas':
          if (h.delay) await h.delay;
          return {
            ok: true,
            value: { ok: true, file: structuredClone(h.antennas), readOnly: false },
          };
        case 'rf:readSectors':
          return {
            ok: true,
            value: {
              ok: true,
              file: structuredClone(h.sectors),
              readOnly: h.readOnly,
              orphans: [],
              ...(h.origins ? { origins: structuredClone(h.origins) } : {}),
            },
          };
        case 'rf:listCatalogue':
          return {
            ok: true,
            value: {
              ok: true,
              entries: [ANTENNA_ENTRY, RADIO_ENTRY, AAU_ENTRY].map((entry) => ({
                origin: 'project',
                entry,
              })),
              warnings: [],
            },
          };
        case 'rf:listRuns':
          return { ok: true, value: { ok: true, runs: [] } };
        case 'rf:writeSectors':
          if (h.writeError) return { ok: true, value: { ok: false, error: h.writeError } };
          if (h.writeDelay) await h.writeDelay;
          h.sectors = structuredClone(req.file) as RfSectorsFile;
          h.origins = req.origins as Record<string, unknown> | undefined;
          return {
            ok: true,
            value: { ok: true, ...(h.writeWarnings ? { warnings: h.writeWarnings } : {}) },
          };
        default:
          return { ok: false, error: 'unexpected' };
      }
    }),
  },
}));

const s = () => rfStore.getState();
const row = (id: string) => {
  const r = s().rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

/** A site with three panels 120 degrees apart, set up for LTE 1800, all in sectors. */
function site(opts: { groundZ?: number | undefined; conv?: number | null } = {}) {
  const conv = opts.conv === undefined ? 0.5 : opts.conv;
  const units = [
    unit('ant-a', 0, { convergenceDeg: conv }),
    unit('ant-b', 120, { convergenceDeg: conv }),
    unit('ant-c', 240, { convergenceDeg: conv }),
  ];
  h.antennas = antennasFile(units, 'groundZ' in opts ? (opts.groundZ ?? null) : 100);
  h.sectors = sectorsFile(
    [
      { id: 'sec-s1', antennaIds: ['ant-a'] },
      { id: 'sec-s2', antennaIds: ['ant-b'] },
      { id: 'sec-s3', antennaIds: ['ant-c'] },
    ],
    units.map((u) => lteSettings(u.id)),
  );
}

beforeEach(() => {
  resetRf();
  setPackStatus({ state: 'ok', version: RF_COVERAGE_MIN_PACK });
  h.calls = [];
  h.antennas = null;
  h.sectors = null;
  h.origins = undefined;
  h.readOnly = false;
  h.writeError = null;
  h.writeWarnings = undefined;
  h.delay = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('height above ground', () => {
  it('is the box centre minus run.groundZ, basis measured', async () => {
    site({ groundZ: 100 });
    await loadRf('p1');
    expect(row('ant-a').height).toMatchObject({ heightM: 31.5, basis: 'measured', groundZ: 100 });
    expect(s().check.refusals).toEqual([]);
  });

  it('without groundZ and without a DSM ground the unit has no height and is left out', async () => {
    site({ groundZ: undefined });
    await loadRf('p1');
    expect(row('ant-a').height).toMatchObject({ heightM: null, basis: null, issue: 'no-ground' });
    expect(row('ant-a').excluded).toBe('no-height');
    expect(s().check.refusals).toEqual(['no-height']);
  });

  it('without groundZ the DSM ground near the base gives an estimated height', async () => {
    site({ groundZ: undefined });
    await loadRf('p1');
    const at = vi.fn(() => 98);
    setDsmGroundProvider(at);
    expect(at).toHaveBeenCalledWith(500000, 2700000);
    expect(row('ant-a').height).toMatchObject({ heightM: 33.5, basis: 'estimated', groundZ: 98 });
    expect(s().check.refusals).toEqual([]);
    setDsmGroundProvider(null);
    expect(row('ant-a').excluded).toBe('no-height');
  });

  it('the typed height wins over measured and estimated', async () => {
    site({ groundZ: 100 });
    await loadRf('p1');
    setHeightOverride('ant-a', 25);
    expect(row('ant-a').height).toMatchObject({ heightM: 25, basis: 'user' });
    expect(s().dirty).toBe(true);
    setHeightOverride('ant-a', undefined);
    expect(row('ant-a').height).toMatchObject({ heightM: 31.5, basis: 'measured' });
  });

  it('the typed height also wins over a DSM estimate', async () => {
    site({ groundZ: undefined });
    await loadRf('p1');
    setDsmGroundProvider(() => 98);
    expect(row('ant-a').height).toMatchObject({ heightM: 33.5, basis: 'estimated' });
    setHeightOverride('ant-a', 25);
    expect(row('ant-a').height).toMatchObject({ heightM: 25, basis: 'user' });
  });

  it('the ground provider does not carry over to the next project', async () => {
    site({ groundZ: undefined });
    await loadRf('p1');
    setDsmGroundProvider(() => 98);
    await loadRf('p2');
    expect(row('ant-a').height.basis).toBeNull();
    expect(s().pack).toEqual({ state: 'ok', version: RF_COVERAGE_MIN_PACK });
  });

  it('a typed height saves a unit with no settings yet, and clearing it leaves the rest', async () => {
    site({ groundZ: undefined });
    h.sectors = sectorsFile([], []);
    await loadRf('p1');
    setHeightOverride('ant-a', 20);
    expect(s().sectors.antennas).toEqual([
      { antennaId: 'ant-a', active: true, carriers: [], heightOverrideM: 20 },
    ]);
  });

  it('a height at or below the ground is not usable', async () => {
    site({ groundZ: 140 });
    await loadRf('p1');
    expect(row('ant-a').height.issue).toBe('not-above-ground');
    expect(row('ant-a').excluded).toBe('not-above-ground');
  });
});

describe('sectors', () => {
  it('proposes sectors by true bearing and applies them without touching RF settings', async () => {
    site();
    h.sectors = sectorsFile([], [lteSettings('ant-a')]);
    await loadRf('p1');
    expect(s().proposed.map((p) => [p.name, p.antennaIds])).toEqual([
      ['S1', ['ant-a']],
      ['S2', ['ant-b']],
      ['S3', ['ant-c']],
    ]);
    expect(s().unassigned).toEqual(['ant-a', 'ant-b', 'ant-c']);
    expect(s().check.refusals).toEqual(['no-sectors']);
    applyProposal();
    expect(s().sectors.sectors.map((x) => x.antennaIds)).toEqual([['ant-a'], ['ant-b'], ['ant-c']]);
    expect(s().sectors.antennas).toHaveLength(1);
    expect(s().unassigned).toEqual([]);
  });

  it('groups panels within 30 degrees into one sector', async () => {
    h.antennas = antennasFile([unit('ant-a', 100), unit('ant-b', 120), unit('ant-c', 300)]);
    await loadRf('p1');
    expect(s().proposed.map((p) => p.antennaIds)).toEqual([['ant-a', 'ant-b'], ['ant-c']]);
  });

  it('a project with no sectors file starts from an empty working copy, not dirty', async () => {
    site();
    h.sectors = null;
    await loadRf('p1');
    expect(s().hasFile).toBe(false);
    expect(s().sectors.sectors).toEqual([]);
    expect(s().dirty).toBe(false);
  });

  it('moves, renames and adds sectors', async () => {
    site();
    await loadRf('p1');
    moveUnit('ant-b', 'sec-s1');
    expect(s().sectors.sectors[0]?.antennaIds).toEqual(['ant-a', 'ant-b']);
    expect(s().sectors.sectors[1]?.antennaIds).toEqual([]);
    renameSector('sec-s1', ' North ');
    expect(s().sectors.sectors[0]?.name).toBe('North');
    const id = addSector();
    expect(id).toBe('sec-s4');
    moveUnit('ant-c', id);
    expect(row('ant-c').sectorId).toBe('sec-s4');
    moveUnit('ant-c', null);
    expect(row('ant-c').sectorId).toBeNull();
  });
});

describe('eligibility and the run check', () => {
  it('a unit without a grid convergence cannot take part; all of them lacking it refuses with no CRS', async () => {
    site({ conv: null });
    await loadRf('p1');
    expect(row('ant-a').excluded).toBe('no-crs');
    expect(s().check.participants).toEqual([]);
    expect(s().check.refusals).toEqual(['no-crs']);
  });

  it('one unit without convergence is left out and the others still run', async () => {
    site();
    h.antennas = antennasFile([
      unit('ant-a', 0, { convergenceDeg: null }),
      unit('ant-b', 120),
      unit('ant-c', 240),
    ]);
    await loadRf('p1');
    expect(s().check.refusals).toEqual([]);
    expect(s().check.participants).toEqual(['ant-b', 'ant-c']);
    expect(s().check.excluded).toEqual([{ antennaId: 'ant-a', reason: 'no-crs' }]);
  });

  it('a draft unit is left out until unreviewed units are included, then marks the run unreviewed', async () => {
    site();
    h.antennas = antennasFile([
      unit('ant-a', 0, { status: 'draft' }),
      unit('ant-b', 120),
      unit('ant-c', 240),
    ]);
    await loadRf('p1');
    expect(row('ant-a')).toMatchObject({ excluded: 'draft', canInclude: true });
    expect(s().check.unreviewed).toBe(false);
    setIncludeUnreviewed(true);
    expect(row('ant-a').excluded).toBeNull();
    expect(row('ant-a').unreviewed).toBe(true);
    expect(s().check.participants).toContain('ant-a');
    expect(s().check.unreviewed).toBe(true);
  });

  it('rejected units never take part', async () => {
    site();
    h.antennas = antennasFile([
      unit('ant-a', 0, { status: 'rejected' }),
      unit('ant-b', 120),
      unit('ant-c', 240),
    ]);
    await loadRf('p1');
    expect(row('ant-a').excluded).toBe('rejected');
    expect(s().check.unreviewed).toBe(false);
  });

  it('a short unit takes part once a person puts it in a sector', async () => {
    h.antennas = antennasFile([unit('ant-a', 0, { kind: 'short' })]);
    h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: [] }], [lteSettings('ant-a')]);
    await loadRf('p1');
    expect(row('ant-a').excluded).toBe('short');
    expect(s().proposed).toEqual([]);
    moveUnit('ant-a', 'sec-s1');
    expect(row('ant-a').excluded).toBeNull();
  });

  it('refuses with no accepted panels when only dishes or rejected units are in sectors', async () => {
    h.antennas = antennasFile([unit('ant-a', 0, { kind: 'other', kindBasis: 'user' })]);
    h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-a'] }], [lteSettings('ant-a')]);
    await loadRf('p1');
    expect(s().check.refusals).toEqual(['no-accepted-panels']);
  });

  it('refuses with no band when no carrier is set', async () => {
    site();
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a', 'ant-b', 'ant-c'] }],
      ['ant-a', 'ant-b', 'ant-c'].map((id) => lteSettings(id, { carriers: [] })),
    );
    await loadRf('p1');
    expect(s().check.refusals).toEqual(['no-band']);
  });

  it('refuses without equipment', async () => {
    site();
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a'] }],
      [{ antennaId: 'ant-a', active: true, carriers: [] }],
    );
    await loadRf('p1');
    expect(s().check.refusals).toEqual(['no-equipment']);
  });

  it('the RF active flag turns a unit off', async () => {
    site();
    await loadRf('p1');
    patchSettings('ant-a', { active: false });
    expect(row('ant-a').excluded).toBe('inactive');
  });

  it('refuses without an antenna inventory', async () => {
    await loadRf('p1');
    expect(s().check.refusals).toEqual(['no-antennas']);
  });

  it('refuses a read only project and a run in progress', async () => {
    site();
    h.readOnly = true;
    await loadRf('p1');
    expect(s().check.refusals).toEqual(['read-only']);
    h.readOnly = false;
    await loadRf('p1');
    setRunning(true, 'job-1');
    expect(s().check.refusals).toEqual(['running']);
    setRunning(false);
    expect(s().jobId).toBeNull();
    expect(s().check.refusals).toEqual([]);
  });

  it('enforces the pipeline pack version', async () => {
    site();
    await loadRf('p1');
    setPackStatus({ state: 'ok', version: '0.1.0' });
    expect(s().check.refusals).toEqual(['pack-too-old']);
    setPackStatus({ state: 'ok', version: RF_COVERAGE_MIN_PACK });
    expect(s().check.refusals).toEqual([]);
    setPackStatus({ state: 'too-old', version: '0.9.0' });
    expect(s().check.refusals).toEqual(['pack-too-old']);
    setPackStatus({ state: 'missing' });
    expect(s().check.refusals).toEqual(['pack-missing']);
    setPackStatus({ state: 'dev' });
    expect(s().check.refusals).toEqual([]);
    setPackStatus(null);
    expect(s().check.refusals).toEqual(['pack-unknown']);
    setPackStatus({ state: 'ok' });
    expect(s().check.refusals).toEqual(['pack-unknown']);
  });
});

describe('orphans', () => {
  it('keeps RF settings and sector places for units detection no longer has', async () => {
    site();
    h.antennas = antennasFile([unit('ant-b', 120), unit('ant-c', 240, { status: 'rejected' })]);
    await loadRf('p1');
    expect(s().orphans).toEqual([
      { antennaId: 'ant-a', reason: 'removed', sectorId: 'sec-s1' },
      { antennaId: 'ant-c', reason: 'rejected', sectorId: 'sec-s3' },
    ]);
    // still in the working copy and in the file
    expect(s().sectors.antennas.map((a) => a.antennaId)).toContain('ant-a');
    expect(s().sectors.sectors[0]?.antennaIds).toEqual(['ant-a']);
    expect(s().dirty).toBe(false);
  });

  it('removes and reassigns only when the person says so', async () => {
    site();
    h.antennas = antennasFile([unit('ant-b', 120), unit('ant-c', 240), unit('ant-d', 10)]);
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a', 'ant-b'] }],
      [lteSettings('ant-a'), lteSettings('ant-b')],
    );
    await loadRf('p1');
    expect(s().orphans.map((o) => o.antennaId)).toEqual(['ant-a']);
    expect(reassignOrphanEntry('ant-a', 'ant-b')).toBe('target-has-settings');
    expect(s().sectors.antennas).toHaveLength(2);
    expect(reassignOrphanEntry('ant-a', 'ant-d')).toBeNull();
    expect(s().orphans).toEqual([]);
    expect(s().sectors.sectors[0]?.antennaIds).toEqual(['ant-d', 'ant-b']);
    removeOrphanEntry('ant-b');
    expect(s().sectors.antennas.map((a) => a.antennaId)).toEqual(['ant-d']);
  });

  it('keeps the place of an orphan across applyProposal and deleteSector', async () => {
    site();
    h.antennas = antennasFile([unit('ant-b', 120), unit('ant-c', 240)]);
    // ant-a is an orphan in sec-s1 (no settings entry of its own beyond the site() ones)
    h.sectors = sectorsFile(
      [
        { id: 'sec-s1', antennaIds: ['ant-a'] },
        { id: 'sec-s9', antennaIds: ['ant-z'] },
      ],
      [lteSettings('ant-b'), lteSettings('ant-c')],
    );
    await loadRf('p1');
    expect(s().orphans.map((o) => o.antennaId)).toEqual(['ant-a', 'ant-z']);
    applyProposal();
    const places = s().sectors.sectors.map((x) => [x.id, x.antennaIds]);
    // ant-a joins the proposed sector with its id; ant-z keeps its old sector, alone
    expect(places).toEqual([
      ['sec-s1', ['ant-b', 'ant-a']],
      ['sec-s2', ['ant-c']],
      ['sec-s9', ['ant-z']],
    ]);
    expect(s().orphans.map((o) => [o.antennaId, o.sectorId])).toEqual([
      ['ant-a', 'sec-s1'],
      ['ant-z', 'sec-s9'],
    ]);
    deleteSector('sec-s1');
    expect(s().sectors.sectors.find((x) => x.id === 'sec-s1')?.antennaIds).toEqual(['ant-a']);
    deleteSector('sec-s2');
    expect(s().sectors.sectors.map((x) => x.id)).toEqual(['sec-s1', 'sec-s9']);
  });

  it('counts an orphan member as a candidate: it stops an all-without-CRS refusal', async () => {
    h.antennas = antennasFile([unit('ant-a', 0, { convergenceDeg: null })]);
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a', 'ant-gone'] }],
      [lteSettings('ant-a')],
    );
    await loadRf('p1');
    expect(s().check.excluded).toEqual([
      { antennaId: 'ant-a', reason: 'no-crs' },
      { antennaId: 'ant-gone', reason: 'removed' },
    ]);
    expect(s().check.refusals).toEqual(['no-accepted-panels']);
  });

  it('checks the height before the equipment, like the job', async () => {
    site({ groundZ: undefined });
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a'] }],
      [{ antennaId: 'ant-a', active: true, carriers: [] }],
    );
    await loadRf('p1');
    expect(row('ant-a').excluded).toBe('no-height');
  });

  it('flags nothing when the project has no inventory', async () => {
    h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-a'] }], [lteSettings('ant-a')]);
    await loadRf('p1');
    expect(s().orphans).toEqual([]);
  });
});

describe('mirrored job defaults', () => {
  it('applies the radio maximum, the port by band and 0 degrees clamped into the port range', async () => {
    site();
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a'] }],
      [
        {
          antennaId: 'ant-a',
          equipment: { kind: 'separate', antenna: 'ant-x', radio: 'rru-x' },
          active: true,
          carriers: [{ id: 'c1', tech: 'lte', band: 'B3', bandwidthMhz: 20, feederLossDb: 0.5 }],
        },
      ],
    );
    await loadRf('p1');
    const [c] = row('ant-a').carriers;
    expect(c).toMatchObject({
      portId: 'high',
      gainDbi: 17,
      etiltDeg: 0,
      powerDbm: 43,
      powerBasis: 'radio-max',
      frequencyMhz: 1842.5,
      subcarriers: 1200,
      feederLossDb: 0.5,
    });
    expect(row('ant-a').warnings.map((w) => w.code)).toEqual([
      'etilt-defaulted',
      'power-radio-max',
    ]);
  });

  it('an AAU uses its total power, an NR 3500 carrier 30 kHz, an NR FDD carrier 15 kHz', async () => {
    site();
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a'] }],
      [
        {
          antennaId: 'ant-a',
          equipment: { kind: 'aau', aau: 'aau-x' },
          active: true,
          carriers: [
            { id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 100, feederLossDb: 0 },
            { id: 'c2', tech: 'nr', band: 'n78', bandwidthMhz: 20, scsKhz: 15, feederLossDb: 0 },
          ],
        },
      ],
    );
    await loadRf('p1');
    const [c1, c2] = row('ant-a').carriers;
    expect(c1).toMatchObject({
      powerDbm: 53,
      powerBasis: 'aau-total',
      scsKhz: 30,
      gainDbi: 24,
      etiltDeg: 3,
    });
    expect(c1?.subcarriers).toBe(12 * 273);
    expect(c2?.scsKhz).toBe(15);
    expect(row('ant-a').warnings.map((w) => w.code)).toContain('scs-defaulted');
  });

  it('a set power and tilt are used as typed; a missing radio leaves the carrier out', async () => {
    site();
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a'] }],
      [
        lteSettings('ant-a', {
          equipment: { kind: 'separate', antenna: 'ant-x' },
          carriers: [
            {
              id: 'c1',
              tech: 'lte',
              band: 'B3',
              bandwidthMhz: 20,
              port: 'high',
              feederLossDb: 0,
              powerDbmPerPort: 40,
            },
            { id: 'c2', tech: 'lte', band: 'B3', bandwidthMhz: 10, port: 'high', feederLossDb: 0 },
          ],
        }),
      ],
    );
    await loadRf('p1');
    const r = row('ant-a');
    expect(r.carriers.map((c) => [c.carrierId, c.powerDbm, c.etiltDeg])).toEqual([['c1', 40, 4]]);
    expect(r.warnings).toEqual([{ code: 'power-missing', carrierId: 'c2' }]);
  });
});

describe('saving', () => {
  it("writes the working copy, keeps main's warnings and clears dirty", async () => {
    site();
    h.writeWarnings = ['pattern a.msi was not copied'];
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    expect(s().dirty).toBe(true);
    expect(await saveRf()).toEqual({ ok: true });
    expect(s().dirty).toBe(false);
    expect(s().writeWarnings).toEqual(['pattern a.msi was not copied']);
    expect(h.sectors?.study.radiusM).toBe(5000);
    expect(s().hasFile).toBe(true);
  });

  it('a refused write keeps the edits and says why', async () => {
    site();
    h.writeError = 'Newer on disk.';
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    expect(await saveRf()).toEqual({ ok: false, code: 'refused', message: 'Newer on disk.' });
    expect(s().dirty).toBe(true);
    expect(s().message).toBe('Newer on disk.');
    expect(s().saving).toBe(false);
  });

  it('refuses edits and saves on a read only project', async () => {
    site();
    h.readOnly = true;
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    expect(s().dirty).toBe(false);
    expect(await saveRf()).toEqual({ ok: false, code: 'read-only' });
    expect(reassignOrphanEntry('ant-a', 'ant-b')).toBe('read-only');
    expect(h.calls.some(([c]) => c === 'rf:writeSectors')).toBe(false);
  });

  it('never writes antennas.json', async () => {
    site();
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    await saveRf();
    expect(h.calls.map(([c]) => c).filter((c) => c.startsWith('telecom:write'))).toEqual([]);
  });
});

describe('loading', () => {
  it('drops a stale answer when the project changed meanwhile', async () => {
    site();
    let release: () => void = () => undefined;
    h.delay = new Promise<void>((r) => {
      release = r;
    });
    const slow = loadRf('p1');
    h.delay = null;
    await loadRf('p2');
    release();
    await slow;
    expect(s().projectId).toBe('p2');
  });

  it('keeps a pending edit across a reload when asked', async () => {
    site();
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    await loadRf('p1', { keepEdits: true });
    expect(s().sectors.study.radiusM).toBe(5000);
    expect(s().dirty).toBe(true);
    await loadRf('p1');
    expect(s().sectors.study.radiusM).toBe(3000);
  });

  it('keeps the saved values when a reload read the file from before the save (M2)', async () => {
    site();
    await loadRf('p1');
    patchStudy({ radiusM: 5000 });
    let endWrite: () => void = () => undefined;
    h.writeDelay = new Promise<void>((r) => {
      endWrite = r;
    });
    const saving = saveRf();
    // the tab mounts again while the write is in flight: its reload reads the old file
    let endRead: () => void = () => undefined;
    h.delay = new Promise<void>((r) => {
      endRead = r;
    });
    const reload = loadRf('p1', { keepEdits: true });
    h.delay = null;
    h.writeDelay = null;
    // the save ends first (no longer dirty), then the reload's answer arrives
    endWrite();
    expect(await saving).toEqual({ ok: true });
    expect(s().dirty).toBe(false);
    endRead();
    await reload;
    expect(s().sectors.study.radiusM).toBe(5000);
    // a later reload, with no save around it, reads the saved file
    await loadRf('p1');
    expect(s().sectors.study.radiusM).toBe(5000);
  });

  it('reads a selected run again', async () => {
    site();
    await loadRf('p1');
    await selectRun('rf-1');
    expect(s().selectedRunId).toBe('rf-1');
    expect(h.calls.some(([c]) => c === 'rf:readRun')).toBe(true);
    await loadRf('p1');
    expect(s().selectedRunId).toBeNull();
  });
});

describe('applying a plan and marking hand edits', () => {
  async function planned() {
    site();
    h.sectors = sectorsFile([], []);
    await loadRf('p1');
    const proposal = buildProposal({
      units: s().antennas?.units ?? [],
      file: s().sectors,
      catalogue: s().catalogue.map((c) => c.entry),
      picks: new Map(),
    });
    applyPlan(proposal);
    return proposal;
  }
  const settings = (id: string) => {
    const x = s().sectors.antennas.find((a) => a.antennaId === id);
    if (!x) throw new Error(`no settings ${id}`);
    return x;
  };

  it('applyPlan writes the proposal and marks the copy dirty', async () => {
    await planned();
    expect(s().dirty).toBe(true);
    expect(s().sectors.sectors.length).toBeGreaterThan(0);
    expect(settings('ant-a').origins?.equipment?.by).toBe('rules');
    expect(settings('ant-a').carriers[0]?.origin?.by).toBe('rules');
  });

  it('a save sends a plain sectors file and the origins apart; a load merges them back', async () => {
    await planned();
    const before = structuredClone(s().sectors);
    expect((await saveRf()).ok).toBe(true);
    const sent = h.calls.find(([c]) => c === 'rf:writeSectors')?.[1];
    expect(JSON.stringify(sent?.file)).not.toMatch(/origin/);
    expect(RfSectorsFile.safeParse(sent?.file).success).toBe(true);
    expect(sent?.origins).toMatchObject({
      'ant-a': { equipment: { by: 'rules' }, carriers: { c1: { by: 'rules' } } },
    });
    resetRf();
    await loadRf('p1');
    expect(s().sectors).toEqual(before);
  });

  it('a load without a sidecar counts every value as set by the person', async () => {
    await planned();
    await saveRf();
    h.origins = undefined;
    resetRf();
    await loadRf('p1');
    expect(settings('ant-a').equipment).toBeDefined();
    expect(settings('ant-a').origins).toBeUndefined();
    expect(settings('ant-a').carriers[0]?.origin).toBeUndefined();
  });

  it('applyPlan does nothing on a read only project', async () => {
    site();
    h.sectors = sectorsFile([], []);
    h.readOnly = true;
    await loadRf('p1');
    applyPlan(
      buildProposal({
        units: s().antennas?.units ?? [],
        file: s().sectors,
        catalogue: s().catalogue.map((c) => c.entry),
        picks: new Map(),
      }),
    );
    expect(s().dirty).toBe(false);
    expect(s().sectors.antennas).toHaveLength(0);
  });

  it('a hand-picked equipment turns an ai group into user', async () => {
    await planned();
    expect(setEquipment('ant-a', AAU_ENTRY)).toBe(true);
    expect(settings('ant-a').origins?.equipment).toEqual({ by: 'user' });
  });

  it('clearing the equipment or the e-tilt marks the group user', async () => {
    await planned();
    clearSetting('ant-a', 'equipment');
    clearSetting('ant-a', 'etiltDeg');
    expect(settings('ant-a').origins?.equipment).toEqual({ by: 'user' });
    expect(settings('ant-a').origins?.etiltDeg).toEqual({ by: 'user' });
  });

  it('Re-plan does not refill a value the person cleared, even after a save and a load', async () => {
    await planned();
    clearSetting('ant-a', 'equipment');
    clearSetting('ant-a', 'etiltDeg');
    await saveRf();
    resetRf();
    await loadRf('p1');
    expect(settings('ant-a').origins).toEqual({
      equipment: { by: 'user' },
      etiltDeg: { by: 'user' },
    });
    applyPlan(
      buildProposal({
        units: s().antennas?.units ?? [],
        file: s().sectors,
        catalogue: s().catalogue.map((c) => c.entry),
        picks: new Map(),
      }),
    );
    expect(settings('ant-a').equipment).toBeUndefined();
    expect(settings('ant-a').etiltDeg).toBeUndefined();
    expect(settings('ant-b').equipment).toBeDefined();
  });

  it('a patch with etiltDeg marks the e-tilt user and leaves the equipment alone', async () => {
    await planned();
    patchSettings('ant-a', { etiltDeg: 5 });
    expect(settings('ant-a').origins?.etiltDeg).toEqual({ by: 'user' });
    expect(settings('ant-a').origins?.equipment?.by).toBe('rules');
  });

  it('editing one carrier field marks only that carrier user', async () => {
    await planned();
    const first = settings('ant-a').carriers[0];
    if (!first) throw new Error('no carrier');
    patchSettings('ant-a', { carriers: [{ ...first, bandwidthMhz: 80 }] });
    expect(settings('ant-a').carriers[0]?.origin).toEqual({ by: 'user' });
    expect(settings('ant-a').origins?.equipment?.by).toBe('rules');
    expect(settings('ant-b').carriers[0]?.origin?.by).toBe('rules');
  });

  it('a patch that leaves a carrier unchanged keeps its origin', async () => {
    await planned();
    patchSettings('ant-a', { carriers: settings('ant-a').carriers, active: false });
    expect(settings('ant-a').carriers[0]?.origin?.by).toBe('rules');
  });

  it('applyCellImport marks the groups it writes export', async () => {
    site();
    await loadRf('p1');
    const rows: CellRow[] = [
      {
        line: 2,
        ref: 'a',
        unitId: 'ant-a',
        unitName: 'a',
        band: 'B3',
        bandwidthMhz: 10,
        etiltDeg: 6,
        radioEntry: 'aau-x',
        problems: [],
      },
    ];
    applyCellImport(rows);
    const a = settings('ant-a');
    expect(a.carriers[0]?.origin).toEqual({ by: 'export', confidence: 'high' });
    expect(a.origins?.etiltDeg).toEqual({ by: 'export', confidence: 'high' });
    expect(a.origins?.equipment).toEqual({ by: 'export', confidence: 'high' });
  });

  it('an e-tilt only row keeps the carrier origin; a rejected radio leaves no export mark', async () => {
    site();
    await loadRf('p1');
    patchSettings('ant-a', {
      carriers: [{ id: 'c1', tech: 'lte', band: 'B3', bandwidthMhz: 20, feederLossDb: 0 }],
    });
    const base: CellRow = { line: 2, ref: 'a', unitId: 'ant-a', unitName: 'a', problems: [] };
    applyCellImport([{ ...base, etiltDeg: 6 }]);
    expect(settings('ant-a').carriers[0]?.origin).toEqual({ by: 'user' });
    expect(settings('ant-a').origins?.etiltDeg?.by).toBe('export');
    // a radio without an antenna is refused by withEquipment, so nothing is written
    clearSetting('ant-b', 'equipment');
    applyCellImport([{ ...base, unitId: 'ant-b', radioEntry: 'rru-x' }]);
    expect(settings('ant-b').equipment).toBeUndefined();
    expect(settings('ant-b').origins?.equipment?.by).toBe('user');
  });
});
