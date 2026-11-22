import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTENNA_FLAG_PACK_FEATURE,
  ANTENNA_PACK_FEATURE,
  antennaPackRefusal,
  hasPersonOwned,
  readAntennaDeletions,
  readAntennaInventory,
  readTurnedDate,
  TURNED_DATE_MIN_PACK,
} from './telecomPack';

const contract = JSON.parse(
  readFileSync(
    new URL('../../../../packages/schema/src/__fixtures__/antennas-contract.json', import.meta.url),
    'utf8',
  ),
) as { example: { units: Record<string, unknown>[] }; flagged: Record<string, unknown> };
const detectedOnly = (): AntennasFile => {
  const units = contract.example.units.map((u) => ({ ...u, user: {} }));
  return AntennasFile.parse({ ...contract.example, units });
};
const withFlagged = (): AntennasFile =>
  AntennasFile.parse({
    ...contract.example,
    units: [...contract.example.units, contract.flagged],
  });

describe('pack gate for telecom.antennas', () => {
  it('requires processing tools 0.14.0 for telecom.antennas only', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.13.1')).toBe(
      'Antenna detection needs processing tools 0.14.0 or later (these are 0.13.1). Update them in Settings, Processing tools.',
    );
    expect(antennaPackRefusal('telecom.antennas', '0.10.0')).toContain('(these are 0.10.0)');
    expect(antennaPackRefusal('telecom.antennas', '0.14.0')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.15.2')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', 'dev')).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', null)).toBeNull();
    expect(antennaPackRefusal('model.evidence', '0.10.0')).toBeNull();
  });
  it('lists the feature for Settings, Processing tools', () => {
    expect(ANTENNA_PACK_FEATURE).toEqual({ label: 'Antenna detection', minVersion: '0.14.0' });
  });
});

describe('pack gate for telecom.flag', () => {
  it('requires 0.24.0 for telecom.flag', () => {
    expect(antennaPackRefusal('telecom.flag', '0.22.0')).toBe(
      'Antenna flagging needs processing tools 0.24.0 or later (these are 0.22.0). Update them in Settings, Processing tools.',
    );
    expect(antennaPackRefusal('telecom.flag', '0.23.0')).toContain('0.24.0');
    expect(antennaPackRefusal('telecom.flag', '0.24.0')).toBeNull();
    expect(antennaPackRefusal('telecom.flag', 'dev')).toBeNull();
    expect(antennaPackRefusal('telecom.flag', null)).toBeNull();
  });
  it('lists the feature', () => {
    expect(ANTENNA_FLAG_PACK_FEATURE).toEqual({ label: 'Antenna flagging', minVersion: '0.24.0' });
  });
  it('refuses telecom.antennas below 0.24.0 only when a person owns something in the file', () => {
    const msg =
      'Antenna flagging needs processing tools 0.24.0 or later (these are 0.22.0). Update them in Settings, Processing tools.';
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', withFlagged())).toBe(msg);
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', detectedOnly())).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', null)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', withFlagged())).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', 'dev', withFlagged())).toBeNull();
  });
  it('refuses telecom.antennas below 0.24.0 when the file is there but cannot be read', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.22.0', 'unreadable')).toContain('0.24.0');
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', 'unreadable')).toBeNull();
  });
  it('knows person-owned units', () => {
    expect(hasPersonOwned(detectedOnly())).toBe(false);
    expect(hasPersonOwned(withFlagged())).toBe(true);
    const f = detectedOnly();
    const u = f.units[0];
    if (!u) throw new Error('no unit');
    u.downtiltDeg = {
      value: 3,
      basis: 'user',
      quality: { ...(u.azimuthGridDeg?.quality ?? { basis: 'geometry' }), basis: 'user' },
    } as never;
    expect(hasPersonOwned(f)).toBe(true);
  });
});

describe('reading the inventory for the gate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const project = (text?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'antenna-gate-'));
    dirs.push(d);
    if (text !== undefined) {
      mkdirSync(join(d, 'telecom'));
      writeFileSync(join(d, 'telecom', 'antennas.json'), text);
    }
    return d;
  };

  it('is null with no file, and for other jobs or no project', async () => {
    expect(await readAntennaInventory('telecom.antennas', project())).toBeNull();
    expect(await readAntennaInventory('survey.volume', project('{}'))).toBeNull();
    expect(await readAntennaInventory('telecom.antennas', undefined)).toBeNull();
  });

  it('reads a valid file', async () => {
    const root = project(JSON.stringify(withFlagged()));
    const r = await readAntennaInventory('telecom.flag', root);
    expect(r !== null && r !== 'unreadable' && hasPersonOwned(r)).toBe(true);
  });

  it('is unreadable when the file is there but is not JSON or not an inventory', async () => {
    expect(await readAntennaInventory('telecom.antennas', project('{ not json'))).toBe(
      'unreadable',
    );
    expect(await readAntennaInventory('telecom.antennas', project('{"units": 3}'))).toBe(
      'unreadable',
    );
  });

  it('is unreadable when the inventory path is there but cannot be accessed', async () => {
    const root = project();
    mkdirSync(join(root, 'telecom', 'antennas.json'), { recursive: true });
    expect(await readAntennaInventory('telecom.antennas', root)).toBe('unreadable');
  });
});

describe('pack gate for deleted antennas', () => {
  const msg = (v: string) =>
    `Deleted antennas stay deleted needs processing tools 0.25.0 or later (these are ${v}). Update them in Settings, Processing tools.`;
  it('refuses a re-detect below 0.25.0 when deletions exist', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', null, true)).toBe(msg('0.24.0'));
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', detectedOnly(), true)).toBe(
      msg('0.24.0'),
    );
  });
  it('allows 0.25.0 with deletions', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.25.0', null, true)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', 'dev', null, true)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', null, null, true)).toBeNull();
  });
  it('ignores an empty sidecar', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', null, false)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', null)).toBeNull();
  });
  it('refuses below 0.25.0 when the sidecar is unreadable', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.24.0', null, 'unreadable')).toBe(
      msg('0.24.0'),
    );
    expect(antennaPackRefusal('telecom.antennas', '0.25.0', null, 'unreadable')).toBeNull();
  });
  it('leaves telecom.flag alone', () => {
    expect(antennaPackRefusal('telecom.flag', '0.24.0', null, true)).toBeNull();
  });
});

describe('reading the deletions sidecar for the gate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const project = (text?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'antenna-del-'));
    dirs.push(d);
    if (text !== undefined) {
      mkdirSync(join(d, 'telecom'));
      writeFileSync(join(d, 'telecom', 'antenna-deletions.json'), text);
    }
    return d;
  };
  const record = {
    unitId: 'ant-a3',
    name: 'A3',
    kind: 'panel',
    box: {
      centre: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [1, 1, 1],
    },
    deletedAt: '2026-10-24T10:00:00Z',
  };
  const file = (deletions: unknown[]) =>
    JSON.stringify({ schema: 'aio.antenna-deletions/1', deletions });

  it('is false with no file, for other jobs and no project', async () => {
    expect(await readAntennaDeletions('telecom.antennas', project())).toBe(false);
    expect(await readAntennaDeletions('telecom.flag', project('{ nope'))).toBe(false);
    expect(await readAntennaDeletions('telecom.antennas', undefined)).toBe(false);
  });
  it('is true only when the file holds a record', async () => {
    expect(await readAntennaDeletions('telecom.antennas', project(file([record])))).toBe(true);
    expect(await readAntennaDeletions('telecom.antennas', project(file([])))).toBe(false);
  });
  it('is unreadable when it is not JSON or not a deletions file', async () => {
    expect(await readAntennaDeletions('telecom.antennas', project('{ nope'))).toBe('unreadable');
    expect(await readAntennaDeletions('telecom.antennas', project('{"deletions": 3}'))).toBe(
      'unreadable',
    );
  });
});

describe('pack gate for a survey date lined up with a turn', () => {
  const turned = (v: string) =>
    `Antenna flagging on a survey date lined up with a turn needs processing tools ${TURNED_DATE_MIN_PACK} or later (these are ${v}). Update them in Settings, Processing tools.`;
  it('flagging on a turned date needs the new pack', () => {
    expect(TURNED_DATE_MIN_PACK).toBe('0.36.0');
    expect(antennaPackRefusal('telecom.flag', '0.35.0', null, false, true)).toBe(turned('0.35.0'));
    expect(antennaPackRefusal('telecom.flag', '0.36.0', null, false, true)).toBeNull();
    expect(antennaPackRefusal('telecom.flag', 'dev', null, false, true)).toBeNull();
    // a date without a turn keeps the flagging floor
    expect(antennaPackRefusal('telecom.flag', '0.35.0', null, false, false)).toBeNull();
    expect(antennaPackRefusal('telecom.flag', '0.24.0')).toBeNull();
    // below the flagging floor the flagging message comes first
    expect(antennaPackRefusal('telecom.flag', '0.23.0', null, false, true)).toContain('0.24.0');
  });
  it('a click on the tower on a turned date needs the new pack', () => {
    expect(antennaPackRefusal('telecom.antennas', '0.35.0', null, false, true)).toBe(
      `Antenna detection from a click on the tower on a survey date lined up with a turn needs processing tools 0.36.0 or later (these are 0.35.0). Update them in Settings, Processing tools.`,
    );
    expect(antennaPackRefusal('telecom.antennas', '0.36.0', null, false, true)).toBeNull();
    expect(antennaPackRefusal('telecom.antennas', '0.35.0', null, false, false)).toBeNull();
  });
});

describe('reading whether a job works on a turned date', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const turn = { rotationDeg: 0.5, scale: 1, pivotE: 400010, pivotN: 2700020 };
  const project = (withTurn: boolean, text?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'antenna-turn-'));
    dirs.push(d);
    const manifest = {
      schema: 'aio.project/1',
      id: 'tower',
      name: 'Synthetic tower',
      crs: { epsg: 32640 },
      origin: [400000, 2700000, 0],
      captures: [
        { id: 'd1', label: 'First survey', date: '2026-03-01' },
        {
          id: 'd2',
          label: 'Second survey',
          date: '2026-09-01',
          lineUp: { eastM: 2, northM: 1, with: 'd1', at: '2026-10-16T08:00:00.000Z' },
          ...(withTurn ? { lineUpTurn: turn } : {}),
        },
      ],
      layers: ['d1', 'd2'].map((c) => ({
        id: `cloud-${c}`,
        name: 'Tower cloud',
        kind: 'pointcloud',
        capture: c,
        src: { path: `clouds/${c}.copc.laz` },
        format: 'copc',
        visible: true,
      })),
      severityModels: [],
      classCatalogues: [],
    };
    writeFileSync(join(d, 'manifest.json'), text ?? JSON.stringify(manifest));
    return d;
  };
  const flag = (layer: string) => ({ cloud: { layer } });

  it('is true for flagging a cloud whose date has a turn', async () => {
    expect(await readTurnedDate('telecom.flag', project(true), flag('cloud-d2'))).toBe(true);
    expect(await readTurnedDate('telecom.flag', project(true), flag('cloud-d1'))).toBe(false);
    expect(await readTurnedDate('telecom.flag', project(false), flag('cloud-d2'))).toBe(false);
  });
  it('is true for a click on the tower when the cloud (or, unnamed, any cloud) is turned', async () => {
    const root = project(true);
    const hint = { run: 'run-a', towerHint: [1, 2] };
    expect(await readTurnedDate('telecom.antennas', root, hint)).toBe(true);
    expect(await readTurnedDate('telecom.antennas', root, { ...hint, ...flag('cloud-d1') })).toBe(
      false,
    );
    expect(await readTurnedDate('telecom.antennas', root, { run: 'run-a' })).toBe(false);
  });
  it('is false for other jobs, no project and a manifest that cannot be read', async () => {
    expect(await readTurnedDate('model.evidence', project(true), flag('cloud-d2'))).toBe(false);
    expect(await readTurnedDate('telecom.flag', undefined, flag('cloud-d2'))).toBe(false);
    expect(await readTurnedDate('telecom.flag', project(true, '{ nope'), flag('cloud-d2'))).toBe(
      false,
    );
  });
});
