import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { setActiveSpace } from '../spaces/activeSpace';
import { measureFrameNow } from './measureFrame';
import { frameOf, spaceFrameOf } from './measureScene';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
}));

/** A georeferenced project (UTM, origin far from zero) with a local confined-space drone space. */
const manifest = {
  name: 'Site',
  crs: { epsg: 32640 },
  origin: [500_000, 3_000_000, 50],
  spaces: [{ id: 'tank', name: 'Tank', crs: { local: 'flyability' }, origin: [0, 0, 0] }],
  layers: [
    { id: 'site', kind: 'pointcloud', name: 'Site' },
    { id: 'scan', kind: 'pointcloud', name: 'Scan', space: 'tank' },
  ],
} as unknown as ProjectManifest;

describe('the measuring frame of a space', () => {
  it('reads a point in a local space in its own metres, not the project grid', () => {
    const f = spaceFrameOf(manifest, 'tank');
    // local x east, y up, z south: 1 m east, 2 m up, 3 m south of the space's origin
    expect(f.toSite([1, 2, 3])).toEqual([1, -3, 2]);
    expect(f.toLocal([1, -3, 2])).toEqual([1, 2, 3]);
    expect(f.epsg).toBeNull();
    expect(f.local).toBe(true);
  });

  it('keeps the project frame for the main space of a georeferenced project', () => {
    const f = spaceFrameOf(manifest, 'main');
    const plain = frameOf(manifest);
    expect(f.toSite([1, 2, 3])).toEqual(plain.toSite([1, 2, 3]));
    expect(f.toSite([1, 2, 3])).toEqual([500_001, 2_999_997, 52]);
    expect(f.epsg).toBe(32640);
    expect(f.local).toBe(false);
  });

  it('follows the active space of the open project', () => {
    workspace.setState({ project: { id: 'p1', manifest } } as never);
    setActiveSpace('p1', 'tank');
    expect(measureFrameNow()?.local).toBe(true);
    expect(measureFrameNow()?.toSite([1, 2, 3])).toEqual([1, -3, 2]);
    setActiveSpace('p1', 'main');
    expect(measureFrameNow()?.epsg).toBe(32640);
    workspace.setState({ project: null } as never);
    expect(measureFrameNow()).toBeNull();
  });
});
