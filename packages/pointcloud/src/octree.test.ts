import { describe, expect, it } from 'vitest';
import {
  childKeys,
  frustumPlanes,
  nodeBounds,
  parentKey,
  parseKey,
  selectNodes,
  type LodNode,
} from './octree';

type V3 = [number, number, number];

describe('octree keys', () => {
  it('parses D-X-Y-Z keys and lists the eight children', () => {
    expect(parseKey('2-1-3-0')).toEqual([2, 1, 3, 0]);
    expect(childKeys('0-0-0-0')).toHaveLength(8);
    expect(childKeys('1-1-0-1')).toContain('2-3-1-3');
    expect(childKeys('1-1-0-1')).toContain('2-2-0-2');
  });

  it('knows the parent of a key, and the root has none', () => {
    expect(parentKey('2-3-1-3')).toBe('1-1-0-1');
    expect(parentKey('0-0-0-0')).toBeNull();
  });

  it('maps a node of the CRS cube to a local-frame box (x east, y up, z south)', () => {
    // cube 100 m wide at E 1000, N 2000, H 10; origin E 1000, N 2100, H 0
    const cube = { min: [1000, 2000, 10] as V3, max: [1100, 2100, 110] as V3 };
    const origin: V3 = [1000, 2100, 0];
    const root = nodeBounds('0-0-0-0', cube, origin);
    expect(root.min).toEqual([0, 10, 0]);
    expect(root.max).toEqual([100, 110, 100]);
    // depth 1, x = 1 (east half), y = 1 (north half), z = 0 (low half)
    const b = nodeBounds('1-1-1-0', cube, origin);
    expect(b.min).toEqual([50, 10, 0]);
    expect(b.max).toEqual([100, 60, 50]);
  });
});

/** A complete octree of `depth` levels over a 64 m cube at the origin, `pts` points per node. */
function tree(depth: number, pts = 100, spacing = 1): LodNode[] {
  const out: LodNode[] = [];
  const cube = { min: [0, 0, 0] as V3, max: [64, 64, 64] as V3 };
  const visit = (key: string) => {
    const [d] = parseKey(key);
    const kids = d < depth ? childKeys(key) : [];
    out.push({
      key,
      points: pts,
      bounds: nodeBounds(key, cube, [0, 64, 0]),
      root: d === 0,
      loaded: false,
      spacing: spacing / 2 ** d,
      children: kids,
    });
    kids.forEach(visit);
  };
  visit('0-0-0-0');
  return out;
}

describe('selectNodes', () => {
  const opts = { budget: 1e9, pxPerM: 1000, minPx: 1 };

  it('always wants the roots, even past the budget', () => {
    const r = selectNodes(tree(2), [32, 200, 32], { ...opts, budget: 10 });
    expect(r.load).toEqual(['0-0-0-0']);
  });

  it('refines while the projected spacing exceeds minPx', () => {
    // root spacing 1 m seen from ~100 m at 1000 px/m: 10 px, so it refines; far away it does not
    const near = selectNodes(tree(3), [32, 150, 32], opts);
    expect(near.load.length).toBeGreaterThan(9);
    const far = selectNodes(tree(3), [32, 64 + 5000, 32], { ...opts, minPx: 1 });
    expect(far.load).toEqual(['0-0-0-0']);
  });

  it('fills the budget with the nearest nodes first and keeps parents before children', () => {
    const r = selectNodes(tree(3), [1, 66, 1], { ...opts, budget: 350 });
    expect(r.load).toHaveLength(3);
    expect(r.load[0]).toBe('0-0-0-0');
    // the child nearest the eye (west, north, high: key 0-1-1) comes next, then its own child
    expect(r.load[1]).toBe('1-0-1-1');
    expect(r.load[2]).toBe('2-0-3-3');
  });

  it('never selects a child whose parent is not selected', () => {
    const r = selectNodes(tree(4), [1, 66, 1], { ...opts, budget: 2000 });
    const set = new Set(r.load);
    for (const k of r.load) {
      const p = parentKey(k);
      if (p) expect(set.has(p)).toBe(true);
    }
  });

  it('culls nodes outside the view frustum', () => {
    // looking down -Z from z = 200 at the far corner: only nodes with small z are in view
    const planes = frustumPlanes({
      eye: [100, 32, 200],
      target: [100, 32, 0],
      fovDeg: 16,
      aspect: 1,
      near: 0.1,
      far: 1000,
    });
    const r = selectNodes(tree(2), [100, 32, 200], { ...opts, frustum: planes });
    expect(r.load).toEqual(['0-0-0-0']);
  });

  it('asks for hierarchy pages the traversal reaches', () => {
    const nodes = tree(1);
    const child = nodes.find((n) => n.key === '1-0-0-0');
    if (!child) throw new Error('missing');
    child.page = true;
    child.points = 0;
    const r = selectNodes(nodes, [1, 66, 1], opts);
    expect(r.pages).toEqual(['1-0-0-0']);
    expect(r.load).not.toContain('1-0-0-0');
  });

  it('keeps loaded nodes within the hysteresis and unloads the rest', () => {
    const nodes = tree(2).map((n) => ({ ...n, loaded: true }));
    const r = selectNodes(nodes, [32, 64 + 5000, 32], opts);
    expect(r.load).toEqual([]);
    expect(r.unload.length).toBe(nodes.length - 1);
    expect(r.unload).not.toContain('0-0-0-0');
  });

  it('treats flat chunks (no children, no spacing) as one level under the roots', () => {
    const flat: LodNode[] = [
      {
        key: 'r',
        points: 10,
        bounds: { min: [0, 0, 0], max: [100, 10, 100] },
        root: true,
        loaded: false,
      },
      {
        key: 'a',
        points: 10,
        bounds: { min: [0, 0, 0], max: [10, 10, 10] },
        root: false,
        loaded: false,
      },
      {
        key: 'b',
        points: 10,
        bounds: { min: [900, 0, 0], max: [910, 10, 10] },
        root: false,
        loaded: false,
      },
    ];
    const r = selectNodes(flat, [5, 5, -20], { ...opts, budget: 20, minScreenRatio: 0.02 });
    expect(r.load).toEqual(['r', 'a']);
  });
});
