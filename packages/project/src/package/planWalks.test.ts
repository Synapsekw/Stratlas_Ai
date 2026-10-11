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
  // a copy that was being written when the app stopped
  { path: 'walks/.staging-vid-2/playback.mp4.part', size: 4000 },
];

describe('planPackage and walks', () => {
  it('carries the finished walk whole, as files no layer owns', () => {
    const p = planPackage(manifest, files, []);
    const paths = p.members.map((m) => m.path);
    expect(paths).toContain('walks/vid-1/walk.json');
    expect(paths).toContain('walks/vid-1/playback.mp4');
    expect(paths).toContain('walks/vid-1/poster.jpg');
    expect(paths).not.toContain('walks/.staging-vid-2/playback.mp4.part');
    expect(p.baseBytes).toBe(2 + 900 + 5000 + 300);
  });

  it('keeps the walk when every layer is left out', () => {
    const p = planPackage(manifest, files, ['pad']);
    const paths = p.members.map((m) => m.path);
    expect(paths).not.toContain('models/pad.glb');
    expect(paths).toContain('walks/vid-1/playback.mp4');
  });
});
