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
  readAntennaInventory,
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
