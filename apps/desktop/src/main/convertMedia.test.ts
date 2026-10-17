import { Issue, ProjectManifest } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { convertMedia } from './convertMedia';

const roots: string[] = [];
const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'convert-fixture',
  name: 'Convert fixture',
  crs: { epsg: 32633 },
  origin: [0, 0, 0],
  captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
  layers: [
    {
      kind: 'photos',
      id: 'photos-1',
      name: 'Photos',
      capture: 'c1',
      items: [
        { id: 'p1', src: { path: 'p1.jpg' }, takenAt: '2026-10-01T09:00:00+02:00' },
        { id: 'p2', src: { path: 'p2.jpg' }, takenAt: '2026-10-01T09:05:00+02:00' },
      ],
    },
  ],
  severityModels: [
    {
      id: 'review',
      name: 'Review',
      levels: [{ value: 1, label: 'Review', color: '#123456', criteria: '' }],
    },
  ],
  classCatalogues: [],
});
const issue = Issue.parse({
  id: 'mark',
  code: 'F01',
  classId: 'mark',
  severityModelId: 'review',
  severity: 1,
  status: 'draft',
  title: 'Synthetic mark',
  note: '',
  author: 'test',
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
  sightings: [
    { on: 'image', layer: 'photos-1', photo: 'p1', geom: { type: 'point', x: 0.5, y: 0.5 } },
  ],
  source: 'human',
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aio-convert-'));
  roots.push(root);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue] }),
  );
  return root;
}
const req = (itemId: string, to: 'pano' | 'photo' = 'pano', layerId = 'photos-1') => ({
  projectId: 'convert-fixture',
  layerId,
  itemId,
  to,
});

describe('convertMedia', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('refuses a package project before writing anything', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'manifest.json'));
    const r = await convertMedia({ root: () => root, package: () => ({}) }, req('p2'));
    expect(r).toEqual({ ok: false, error: 'A package cannot be changed.' });
    expect(await readFile(join(root, 'manifest.json'))).toEqual(before);
  });

  it('refuses a photo with an image sighting before writing anything', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'manifest.json'));
    const r = await convertMedia({ root: () => root, package: () => undefined }, req('p1'));
    expect(r).toEqual({ ok: false, error: 'This photo has marks on it. Remove them first.' });
    expect(await readFile(join(root, 'manifest.json'))).toEqual(before);
  });

  it('turns an unmarked photo into a 360 and saves the manifest', async () => {
    const root = await fixture();
    const r = await convertMedia({ root: () => root, package: () => undefined }, req('p2'));
    expect(r).toMatchObject({ ok: true, layerId: 'panos-2026-10-01', itemId: 'p2' });
    const saved = ProjectManifest.parse(
      JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
    );
    expect(saved.layers.map((l) => l.id)).toEqual(['photos-1', 'panos-2026-10-01']);
  });

  it('refuses a missing item', async () => {
    const root = await fixture();
    const r = await convertMedia({ root: () => root, package: () => undefined }, req('nope'));
    expect(r.ok).toBe(false);
  });
});
