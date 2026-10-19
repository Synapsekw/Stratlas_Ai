import { describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../bridge';
import {
  createLineUpPreview,
  overviewLevel,
  readLineUpExtents,
  type PreviewDeps,
} from './lineUpPreview';
import { cloud, lineUpManifest, ortho } from './testing';

const pyramid = (id: string, capture: string) => ({
  ...ortho(id, capture),
  format: 'kit-pyramid',
  src: { path: `${id}/tiles.json` },
});
const level = (z: number, cols: number, rows: number) => ({
  z,
  tileSize: 256,
  cols,
  rows,
  pattern: `o1/{z}/{x}_{y}.png`,
});

function deps(over: Partial<PreviewDeps> = {}): PreviewDeps {
  return {
    manifest: () =>
      lineUpManifest({ layers: [pyramid('o1', 'd1'), ortho('o2', 'd2'), cloud('c2')] }),
    extents: () => Promise.resolve({ o1: { min: [10, 0, 20], max: [110, 5, 70] } }),
    readJson: () => Promise.resolve({ levels: [level(2, 8, 8), level(0, 1, 1), level(1, 2, 2)] }),
    loadTile: vi.fn(() => Promise.resolve({} as CanvasImageSource)),
    stitch: vi.fn(() => ({}) as CanvasImageSource),
    ...over,
  };
}

describe('line-up preview', () => {
  it('takes the coarsest level that is a handful of tiles', () => {
    expect(overviewLevel({ levels: [level(2, 8, 8), level(1, 2, 2), level(0, 1, 1)] })?.z).toBe(0);
    expect(overviewLevel({ levels: [level(3, 9, 9)] })).toBeNull();
    expect(overviewLevel({})).toBeNull();
  });

  it('stitches the overview tiles over the layer box as placed now', async () => {
    const d = deps({
      readJson: () => Promise.resolve({ levels: [level(1, 2, 2), level(2, 8, 8)] }),
    });
    const image = await createLineUpPreview(d)('o1');
    expect(d.loadTile).toHaveBeenCalledTimes(4);
    expect(d.loadTile).toHaveBeenCalledWith('o1/1/1_1.png');
    expect(image?.box).toEqual({ minX: 10, maxX: 110, minZ: 20, maxZ: 70 });
  });

  it('has no preview for a layer without a cheap overview', async () => {
    const d = deps();
    const preview = createLineUpPreview(d);
    expect(await preview('o2')).toBeNull();
    expect(await preview('c2')).toBeNull();
    expect(await preview('missing')).toBeNull();
    expect(d.loadTile).not.toHaveBeenCalled();
    expect(
      await createLineUpPreview(deps({ loadTile: () => Promise.resolve(null) }))('o1'),
    ).toBeNull();
  });
});

describe('line-up extents', () => {
  it('asks for full extents, so a kit pyramid with its corners only in tiles.json has a box', async () => {
    const call = vi.fn((_channel: string, req: { projectId: string; full?: boolean }) =>
      Promise.resolve({
        ok: true as const,
        value: {
          ok: true as const,
          // main answers the kit pyramid only when asked for full extents
          extents: req.full ? [{ layerId: 'o1', min: [10, 0, 20], max: [110, 5, 70] }] : [],
          recentre: { blockers: [] },
        },
      }),
    );
    const extents = () => readLineUpExtents({ call } as unknown as Bridge, 'p1');
    expect(await extents()).toEqual({ o1: { min: [10, 0, 20], max: [110, 5, 70] } });
    expect(call).toHaveBeenCalledWith('builder:layerExtents', { projectId: 'p1', full: true });
    const image = await createLineUpPreview(deps({ extents }))('o1');
    expect(image?.box).toEqual({ minX: 10, maxX: 110, minZ: 20, maxZ: 70 });
  });
});
