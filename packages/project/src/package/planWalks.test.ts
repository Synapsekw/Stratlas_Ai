import { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { planPackage, type SourceFile } from './plan';

/* 360 video lives in `walks/<id>/`, which no layer owns: a package carries it as it is. */

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'site',
  name: 'Site',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [{ kind: 'mesh', id: 'pad', name: 'Pad', src: { path: 'models/pad.glb' }, transform: I }],
  severityModels: [],
  classCatalogues: [],
});

const files: SourceFile[] = [
  { path: 'models/pad.glb', size: 10 },
  { path: 'issues.json', size: 2 },
  { path: 'walks/vid-1/walk.json', size: 900 },
  { path: 'walks/vid-1/playback.mp4', size: 5000 },
  { path: 'walks/vid-1/poster.jpg', size: 300 },
  // what an import that was interrupted left in its staging folder: half a stitch, and half a
  // stored-as-is copy under the final file name
  { path: 'walks/.staging-vid-2-0a1b2c3d/playback.mp4.part', size: 4000 },
  { path: 'walks/.staging-tour-9f8e7d6c/playback.mp4', size: 7000 },
  { path: 'walks/.staging-tour-9f8e7d6c/poster.jpg', size: 70 },
  { path: 'walks/.staging-done-11223344/walk.json', size: 800 },
];

describe('planPackage and walks', () => {
  it('carries the finished walk whole, as files no layer owns', () => {
    const p = planPackage(manifest, files, []);
    const paths = p.members.map((m) => m.path);
    expect(paths).toContain('walks/vid-1/walk.json');
    expect(paths).toContain('walks/vid-1/playback.mp4');
    expect(paths).toContain('walks/vid-1/poster.jpg');
    // nothing of a staging folder travels, whatever its files are called
    expect(paths.filter((x) => x.startsWith('walks/.staging-'))).toEqual([]);
    expect(p.baseBytes).toBe(2 + 900 + 5000 + 300);
    expect(p.totalBytes).toBe(10 + 2 + 900 + 5000 + 300);
  });

  it('keeps the walk when every layer is left out', () => {
    const p = planPackage(manifest, files, ['pad']);
    const paths = p.members.map((m) => m.path);
    expect(paths).not.toContain('models/pad.glb');
    expect(paths).toContain('walks/vid-1/playback.mp4');
  });
});
