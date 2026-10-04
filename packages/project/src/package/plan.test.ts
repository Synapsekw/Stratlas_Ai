import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { planPackage, type SourceFile } from './plan';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function manifest(): ProjectManifest {
  const m: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'hcl',
    name: 'HCl',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      { kind: 'mesh', id: 'tank', name: 'Tank', src: { path: 'models/tank.glb' }, transform: I },
      {
        kind: 'pointcloud',
        id: 'c1',
        name: 'Cloud 1',
        src: { path: 'clouds/f101.bin' },
        format: 'kit-packed',
      },
      {
        kind: 'pointcloud',
        id: 'c2',
        name: 'Cloud 2',
        src: { path: 'clouds/big/index.json' },
        format: 'png-packed',
      },
      ...['v1', 'v2'].map((id) => ({
        kind: 'video' as const,
        id,
        name: id,
        src: { path: `video/${id}.mp4` },
        poster: { path: `posters/${id}.jpg` },
        flight: { src: { path: 'flights/f101.json' }, startUtcMs: 0 },
        lens: { model: 'pinhole' as const, hfovDeg: 80, aspect: 1.5 },
      })),
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Ortho',
        src: { path: 'rasters/ortho/tiles.json' },
        role: 'ortho',
        format: 'kit-pyramid',
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [{ id: 'p1', src: { path: 'photos/p1.jpg' } }],
      },
      {
        kind: 'legacy',
        id: 'legacy',
        name: 'Original review',
        viewer: 'aik',
        entry: { path: 'legacy/OPEN Review.html' },
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  return ProjectManifest.parse(m);
}

const files: SourceFile[] = [
  { path: 'manifest.json', size: 900 },
  { path: 'issues.json', size: 100 },
  { path: 'issues.json.bak', size: 100 },
  { path: 'IMPORT-REPORT.md', size: 10 },
  { path: 'thumbnail.jpg', size: 50 },
  { path: 'report/report.pdf', size: 1000 },
  { path: 'models/tank.glb', size: 2000 },
  { path: 'clouds/f101.bin', size: 3000 },
  { path: 'clouds/big/index.json', size: 10 },
  { path: 'clouds/big/c000.png', size: 4000 },
  { path: 'video/v1.mp4', size: 5000 },
  { path: 'video/v2.mp4', size: 6000 },
  { path: 'posters/v1.jpg', size: 7 },
  { path: 'posters/v2.jpg', size: 8 },
  { path: 'flights/f101.json', size: 70 },
  { path: 'rasters/ortho/tiles.json', size: 5 },
  { path: 'rasters/ortho/0/0_0.webp', size: 500 },
  { path: 'photos/p1.jpg', size: 300 },
  { path: 'photos/thumbs/p1.jpg', size: 30 },
  { path: 'photos/masks/p1_mask.png', size: 40 },
  { path: 'legacy/OPEN Review.html', size: 20 },
  { path: 'legacy/data/model.js', size: 9000 },
  { path: 'old.aio', size: 99999 },
  { path: 'x.tmp', size: 1 },
];

const paths = (p: ReturnType<typeof planPackage>) => p.members.map((m) => m.path).sort();

describe('planPackage', () => {
  it('takes every project file except backups, temp files, import notes and packages', () => {
    const p = planPackage(manifest(), files, []);
    expect(paths(p)).not.toContain('issues.json.bak');
    expect(paths(p)).not.toContain('IMPORT-REPORT.md');
    expect(paths(p)).not.toContain('old.aio');
    expect(paths(p)).not.toContain('x.tmp');
    // The manifest is written fresh by the exporter.
    expect(paths(p)).not.toContain('manifest.json');
    expect(paths(p)).toContain('issues.json');
    expect(paths(p)).toContain('legacy/data/model.js');
    expect(p.manifest.layers).toHaveLength(8);
  });

  it('drops the files of excluded clouds, including the chunks beside an index', () => {
    const p = planPackage(manifest(), files, ['c1', 'c2']);
    expect(paths(p)).not.toContain('clouds/f101.bin');
    expect(paths(p)).not.toContain('clouds/big/c000.png');
    expect(paths(p)).not.toContain('clouds/big/index.json');
    expect(p.manifest.layers.map((l) => l.id)).not.toContain('c1');
    expect(p.excluded).toEqual(['c1', 'c2']);
  });

  it('keeps a flight file while any clip that uses it stays', () => {
    const one = planPackage(manifest(), files, ['v1']);
    expect(paths(one)).not.toContain('video/v1.mp4');
    expect(paths(one)).not.toContain('posters/v1.jpg');
    expect(paths(one)).toContain('flights/f101.json');
    const both = planPackage(manifest(), files, ['v1', 'v2']);
    expect(paths(both)).not.toContain('flights/f101.json');
  });

  it('drops a tile pyramid folder, photo thumbnails and the whole legacy viewer', () => {
    const p = planPackage(manifest(), files, ['ortho', 'photos', 'legacy']);
    expect(paths(p)).not.toContain('rasters/ortho/0/0_0.webp');
    expect(paths(p)).not.toContain('photos/thumbs/p1.jpg');
    expect(paths(p)).not.toContain('legacy/data/model.js');
    // Issue masks are not a layer's files: they stay with the issues.
    expect(paths(p)).toContain('photos/masks/p1_mask.png');
  });

  it('reports bytes per layer, the base and the total for the exclusions', () => {
    const p = planPackage(manifest(), files, ['c2']);
    const byId = Object.fromEntries(p.layers.map((l) => [l.id, l]));
    expect(byId.c1?.bytes).toBe(3000);
    expect(byId.c2?.bytes).toBe(4010);
    expect(byId.c2?.files).toBe(2);
    // Shared flight file belongs to neither clip alone.
    expect(byId.v1?.bytes).toBe(5007);
    expect(byId.legacy?.bytes).toBe(9020);
    expect(p.baseBytes).toBe(100 + 50 + 1000 + 40);
    expect(p.totalBytes).toBe(p.members.reduce((n, m) => n + m.size, 0));
    expect(p.totalFiles).toBe(p.members.length);
  });

  it('ignores exclusions that name no layer', () => {
    const p = planPackage(manifest(), files, ['nope']);
    expect(p.excluded).toEqual([]);
  });
});
