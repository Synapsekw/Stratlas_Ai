import type { ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeInspectorFixture, FIXTURE_EMAIL } from './fixture';
import { byCodePoint, findInspectorExport, scanInspectorExport } from './scan';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inspector-scan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('findInspectorExport', () => {
  it('finds the export in the folder or a direct child', async () => {
    await writeInspectorFixture(join(dir, 'export'));
    expect(await findInspectorExport(join(dir, 'export'))).toBe(join(dir, 'export'));
    expect(await findInspectorExport(dir)).toBe(join(dir, 'export'));
  });

  it('a folder without pois/ is not an export', async () => {
    await mkdir(join(dir, 'flights'), { recursive: true });
    await mkdir(join(dir, 'maps'), { recursive: true });
    await mkdir(join(dir, 'snapshots'), { recursive: true });
    expect(await findInspectorExport(dir)).toBeNull();
  });
});

describe('scanInspectorExport', () => {
  it('lists inspections, flights, alignment and finding counts', async () => {
    const ids = await writeInspectorFixture(dir, { generation: '2025' });
    const scan = await scanInspectorExport(dir, null);
    expect(scan.generation).toBe('2025-mcap');
    expect(scan.asset).toBe('Synthetic chamber');
    expect(scan.inspections).toHaveLength(1);
    const insp = scan.inspections[0];
    if (!insp) throw new Error('no inspection');
    expect(insp).toMatchObject({
      id: ids.inspectionId,
      name: 'Synthetic room',
      mergedCloud: true,
      findings: 3,
      importedAs: null,
    });
    const [a, b] = ids.flightIds.map((id) => insp.flights.find((f) => f.id === id));
    expect(a).toMatchObject({ aligned: 'relocalised', cloud: true, path: true });
    expect(b).toMatchObject({ aligned: 'transform', cloud: true, path: true });
    expect(a?.name).toBe('Flight #1');
  });

  it('reads the 2024 generation from the log suffix and a reference flight', async () => {
    await writeInspectorFixture(dir, { generation: '2024', transform: false });
    const scan = await scanInspectorExport(dir, null);
    expect(scan.generation).toBe('2024-bag');
    expect(scan.inspections[0]?.flights.map((f) => f.aligned)).toEqual([
      'relocalised',
      'reference',
    ]);
  });

  it('marks an inspection already imported as a space', async () => {
    const ids = await writeInspectorFixture(dir);
    const manifest = {
      name: 'P',
      layers: [],
      spaces: [
        {
          id: 'space-room',
          name: 'Room',
          source: { kind: 'flyability', inspectionId: ids.inspectionId },
        },
      ],
    } as unknown as ProjectManifest;
    const scan = await scanInspectorExport(dir, manifest);
    expect(scan.inspections[0]?.importedAs).toBe('space-room');
  });

  it('skips backup files and holds no e-mail', async () => {
    await writeInspectorFixture(dir);
    const scan = await scanInspectorExport(dir, null);
    const text = JSON.stringify(scan);
    expect(text).not.toContain(FIXTURE_EMAIL);
    expect(text).not.toContain('Old name');
    expect(text).not.toContain('Old flight');
  });

  async function snapshot(root: string, id: string, extra: Record<string, unknown>): Promise<void> {
    await mkdir(join(root, 'snapshots', id), { recursive: true });
    await writeFile(join(root, 'snapshots', id, 'snapshot.json'), JSON.stringify({ id, ...extra }));
  }

  it('counts orphan and unknown-flight snapshots like the import', async () => {
    const ids = await writeInspectorFixture(dir);
    await snapshot(dir, 'orphan-1', { flight_id: ids.flightIds[0], poi_id: '' });
    await snapshot(dir, 'lost-1', { flight_id: 'nope', poi_id: ids.poiIds[0] });
    await snapshot(dir, 'lost-2', { flight_id: 'nope', poi_id: 'unknown-poi' });
    const scan = await scanInspectorExport(dir, null);
    // 3 POIs, orphan-1 and lost-2 (own keys); lost-1 joins POI 1 in the sole inspection.
    expect(scan.inspections[0]?.findings).toBe(5);
  });

  it('groups flights and findings per inspection and skips strays', async () => {
    const ids = await writeInspectorFixture(dir);
    const insp2 = 'insp-two';
    await mkdir(join(dir, 'inspections', insp2), { recursive: true });
    await writeFile(
      join(dir, 'inspections', insp2, 'inspection.json'),
      JSON.stringify({ id: insp2, name: 'Second', asset_id: ids.assetId }),
    );
    for (const [fid, at] of [
      ['fl-late', 200],
      ['fl-early', 100],
    ] as const) {
      await mkdir(join(dir, 'flights', fid), { recursive: true });
      await writeFile(
        join(dir, 'flights', fid, 'flight.json'),
        JSON.stringify({ id: fid, name: fid, inspection_id: insp2, datetime_utc: at }),
      );
    }
    await snapshot(dir, 's-2a', { flight_id: 'fl-late', poi_id: ids.poiIds[1] });
    await snapshot(dir, 's-stray', { flight_id: 'nope', poi_id: ids.poiIds[1] });
    const scan = await scanInspectorExport(dir, null);
    const [first, second] = scan.inspections;
    expect(first?.flights).toHaveLength(2);
    expect(first?.findings).toBe(3);
    expect(second?.flights.map((f) => f.id)).toEqual(['fl-early', 'fl-late']);
    expect(second?.findings).toBe(1);
    expect(second?.mergedCloud).toBe(false);
  });

  it('names and orders flights like the import', async () => {
    // Same case as test_flight_ids_and_order_match_the_scan in python/tests/test_flyability_export.py.
    const ids = await writeInspectorFixture(dir);
    const iid = ids.inspectionId;
    const flights: [string, Record<string, unknown>][] = [
      ['fl-no-id', { name: 'b', inspection_id: iid, datetime_utc: 5 }],
      ['fl-empty-id', { id: '', name: 'a', inspection_id: iid, datetime_utc: 5 }],
      ['fl-upper', { id: 'z1', name: 'Z', inspection_id: iid, datetime_utc: 5.7 }],
      ['fl-lower', { id: 'z0', name: 'a', inspection_id: iid, datetime_utc: 5 }],
      ['fl-none', { id: 'n0', name: 7, inspection_id: iid }],
    ];
    for (const [folder, data] of flights) {
      await mkdir(join(dir, 'flights', folder), { recursive: true });
      await writeFile(join(dir, 'flights', folder, 'flight.json'), JSON.stringify(data));
    }
    const scan = await scanInspectorExport(dir, null);
    const order = scan.inspections[0]?.flights.map((f) => f.id);
    expect(order?.filter((f) => !ids.flightIds.includes(f))).toEqual([
      'n0',
      'z1',
      'fl-empty-id',
      'z0',
      'fl-no-id',
    ]);
  });
});

describe('byCodePoint', () => {
  it('orders by code point, upper case first, astral after BMP', () => {
    expect(['b', 'a', 'Z', '\u{1F600}', '\uFFFD'].sort(byCodePoint)).toEqual([
      'Z',
      'a',
      'b',
      '\uFFFD',
      '\u{1F600}',
    ]);
    expect(byCodePoint('ab', 'a')).toBeGreaterThan(0);
    expect(byCodePoint('a', 'a')).toBe(0);
  });
});
