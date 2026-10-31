import type { ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeInspectorFixture, FIXTURE_EMAIL } from './fixture';
import { findInspectorExport, scanInspectorExport } from './scan';

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
});
