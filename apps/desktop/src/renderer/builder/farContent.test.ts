import { describe, expect, it, vi } from 'vitest';
import { createFarNotice, farLayers, planGap, recentreTarget } from './farContent';

const box = (x: number, z: number, s = 50) =>
  ({ min: [x - s, 0, z - s], max: [x + s, 20, z + s] }) as const;

describe('far rule', () => {
  it('measures plan gaps between boxes, 0 when they overlap', () => {
    expect(planGap(box(0, 0), box(0, 0))).toBe(0);
    expect(planGap(box(0, 0), box(1100, 0))).toBe(1000);
  });
  it('a new layer far from the origin and every older layer is far', () => {
    const ex = [
      { layerId: 'photos', ...box(0, 0) },
      { layerId: 'cloud', ...box(91_000, -2_000) },
    ];
    const far = farLayers(ex, new Set(['photos']));
    expect(far.map((f) => f.layerId)).toEqual(['cloud']);
    expect(far[0]?.distanceM).toBeCloseTo(Math.hypot(90_950, 1_950), 0);
  });
  it('a new section next to an older one is not far, wherever the origin is', () => {
    const ex = [
      { layerId: 'old', ...box(15_000, 0) },
      { layerId: 'new', ...box(16_000, 0) },
    ];
    expect(farLayers(ex, new Set(['old']))).toEqual([]);
  });
  it('two far layers of one site make one notice and one target', () => {
    const ex = [
      { layerId: 'cloud', ...box(30_000, 0) },
      { layerId: 'mesh', ...box(30_020, 10, 5) },
    ];
    const far = farLayers(ex, new Set());
    expect(far.map((f) => f.layerId)).toEqual(['cloud', 'mesh']);
    expect(recentreTarget(far, [500_000, 3_200_000, 20])).toEqual([530_000, 3_200_000]);
  });
});

describe('notice', () => {
  const project = {
    id: 'p',
    root: '/p',
    manifest: {
      origin: [500_000, 3_200_000, 20] as [number, number, number],
      layers: [
        { kind: 'pointcloud', id: 'cloud', name: 'Cloud' },
        { kind: 'photos', id: 'photos', name: 'Photos' },
      ],
    },
  };
  const deps = (blockers: string[] = []) => {
    const call = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'builder:layerExtents'
          ? {
              ok: true,
              extents: [
                { layerId: 'photos', ...box(0, 0) },
                { layerId: 'cloud', ...box(91_250, 0) },
              ],
              recentre: { blockers },
            }
          : {
              ok: true,
              manifest: { ...project.manifest, origin: [591_250, 3_200_000, 20] },
              backup: 'b',
            },
      ),
    );
    const reopen = vi.fn();
    return { call, reopen, project: () => project };
  };
  it('names the far layer and its distance, and re-centres on request', async () => {
    const d = deps();
    const s = createFarNotice(d);
    await s.getState().check('p', new Set(['cloud']));
    // 91,250 m to the box centre, 91,200 m to its near edge
    expect(s.getState().notice?.text).toContain('Cloud lies 91.2 km from the project origin');
    expect(s.getState().notice?.canRecentre).toBe(true);
    await s.getState().recentre();
    expect(d.call).toHaveBeenCalledWith('builder:recentre', {
      projectId: 'p',
      at: [591_250, 3_200_000],
    });
    expect(d.reopen).toHaveBeenCalled();
    expect(s.getState().notice?.text).toContain('Re-centred');
  });
  it('says why re-centring is not offered', async () => {
    const s = createFarNotice(deps(['2 issues']));
    await s.getState().check('p', new Set(['cloud']));
    expect(s.getState().notice?.canRecentre).toBe(false);
    expect(s.getState().notice?.text).toContain('not offered: this project holds 2 issues');
  });
  it('stays quiet when nothing is far', async () => {
    const s = createFarNotice(deps());
    await s.getState().check('p', new Set(['photos']));
    expect(s.getState().notice).toBeNull();
  });
});
