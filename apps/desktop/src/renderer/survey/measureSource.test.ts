import type { Layer, PickedOn, ProjectManifest, SitePoint } from '@aio/schema';
import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import {
  alignPicks,
  baseLayer,
  creationDating,
  mapPickLayer,
  realignPickedOn,
  type VertexPick,
} from './measureSource';

const raster = (
  id: string,
  role: 'dsm' | 'ortho',
  capture?: string,
  corners?: {
    tl: [number, number, number];
    tr: [number, number, number];
    bl: [number, number, number];
  },
): Layer => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  role,
  format: 'cog',
  src: { path: `rasters/${id}.tif` },
  ...(capture ? { capture } : {}),
  ...(corners ? { corners } : {}),
});
const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ...(capture ? { capture } : {}),
});

const manifest = (layers: Layer[], captures = true): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: captures
    ? [
        { id: 'c1', label: 'First', date: '2026-01-01' },
        { id: 'c2', label: 'Second', date: '2026-02-01' },
      ]
    : [],
  layers,
  severityModels: [],
  classCatalogues: [],
});

const ground = (layer: string | null): VertexPick => ({ layer, on: 'ground' });
const model = (layer: string | null): VertexPick => ({ layer, on: 'model' });

describe('creationDating', () => {
  const m = manifest([
    raster('dsm1', 'dsm', 'c1'),
    raster('ortho1', 'ortho', 'c1'),
    mesh('mesh2', 'c2'),
    raster('ortho2', 'ortho', 'c2'),
    mesh('common'),
  ]);
  const index = captureIndex(m);

  it('creationDating takes the first vertex layer and its date', () => {
    const d = creationDating([model('mesh2'), ground('dsm1')], { index, manifest: m, focus: 'c1' });
    expect(d).toEqual({
      scope: { kind: 'survey', capture: 'c2' },
      source: { layer: 'mesh2' },
      pickedOn: ['model', 'ground'],
    });
  });

  it('an every-date layer takes the focused date, else the newest', () => {
    const picks = [model('common')];
    expect(creationDating(picks, { index, manifest: m, focus: 'c1' }).scope).toEqual({
      kind: 'survey',
      capture: 'c1',
    });
    expect(creationDating(picks, { index, manifest: m, focus: null }).scope).toEqual({
      kind: 'survey',
      capture: 'c2',
    });
    expect(creationDating(picks, { index, manifest: m, focus: 'gone' }).scope).toEqual({
      kind: 'survey',
      capture: 'c2',
    });
  });

  it('no layer under the first vertex falls back to the focused date base layer', () => {
    const d = creationDating([ground(null)], { index, manifest: m, focus: 'c1' });
    expect(d.scope).toEqual({ kind: 'survey', capture: 'c1' });
    expect(d.source).toEqual({ layer: 'dsm1' });
    const noDsm = manifest([raster('ortho1', 'ortho', 'c1'), mesh('mesh2', 'c2')]);
    const d2 = creationDating([ground(null)], {
      index: captureIndex(noDsm),
      manifest: noDsm,
      focus: 'c1',
    });
    expect(d2.source).toEqual({ layer: 'ortho1' });
    expect(baseLayer(captureIndex(noDsm), noDsm, 'c2')).toBe('mesh2');
  });

  it('a project with no dates keeps site scope but records the source', () => {
    const none = manifest([raster('dsm', 'dsm'), raster('ortho', 'ortho')], false);
    const idx = captureIndex(none);
    expect(creationDating([ground('ortho')], { index: idx, manifest: none, focus: null })).toEqual({
      scope: { kind: 'site' },
      source: { layer: 'ortho' },
      pickedOn: ['ground'],
    });
    expect(
      creationDating([ground(null)], { index: idx, manifest: none, focus: null }).source,
    ).toEqual({ layer: 'dsm' });
  });
});

describe('mapPickLayer', () => {
  const box = (x0: number, x1: number) => ({
    tl: [x0, 0, 0] as [number, number, number],
    tr: [x1, 0, 0] as [number, number, number],
    bl: [x0, 0, 10] as [number, number, number],
  });

  it('mapPickLayer prefers the shown DSM over the ortho and skips hidden rasters', () => {
    const m = manifest([
      raster('dsm1', 'dsm', 'c1', box(0, 10)),
      raster('ortho1', 'ortho', 'c1', box(0, 10)),
    ]);
    const index = captureIndex(m);
    expect(mapPickLayer(m, index, {}, [5, 0, 5])).toBe('dsm1');
    expect(mapPickLayer(m, index, { dsm1: true }, [5, 0, 5])).toBe('ortho1');
    expect(mapPickLayer(m, index, { dsm1: true, ortho1: true }, [5, 0, 5])).toBeNull();
    expect(mapPickLayer(m, index, {}, [50, 0, 5])).toBeNull();
  });

  it('mapPickLayer takes the last raster in manifest order when two DSMs overlap', () => {
    const m = manifest([
      raster('dsmA', 'dsm', 'c1', box(0, 10)),
      raster('dsmB', 'dsm', 'c2', box(5, 20)),
    ]);
    const index = captureIndex(m);
    expect(mapPickLayer(m, index, {}, [7, 0, 5])).toBe('dsmB');
    expect(mapPickLayer(m, index, {}, [2, 0, 5])).toBe('dsmA');
  });

  it('a raster without corners covers every point, an undated one is never picked', () => {
    const m = manifest([raster('dsm1', 'dsm', 'c1'), raster('undated', 'dsm')]);
    const index = captureIndex(m);
    expect(mapPickLayer(m, index, {}, [999, 0, 999])).toBe('dsm1');
  });
});

describe('picks and pickedOn follow the points', () => {
  it('alignPicks follows points added and removed', () => {
    const a = alignPicks([], 1, model('l1'));
    expect(a).toEqual([model('l1')]);
    expect(alignPicks(a, 2, null)).toEqual([model('l1'), ground('l1')]);
    expect(alignPicks([model('l1'), ground('l1'), model('l2')], 1, null)).toEqual([model('l1')]);
    expect(alignPicks([], 2, null)).toEqual([ground(null), ground(null)]);
  });

  it('realignPickedOn keeps kinds of kept vertices across an inserted midpoint and a deleted vertex', () => {
    const p = (n: number): SitePoint => [n, n, n];
    const kinds: PickedOn[] = ['model', 'ground', 'model'];
    const before = [p(1), p(2), p(3)];
    const mid: SitePoint = [1.5, 1.5, 1.5];
    expect(realignPickedOn(before, [p(1), mid, p(2), p(3)], kinds)).toEqual([
      'model',
      'model',
      'ground',
      'model',
    ]);
    expect(realignPickedOn(before, [p(1), p(3)], kinds)).toEqual(['model', 'model']);
    expect(realignPickedOn(before, [[9, 9, 9], p(2)], kinds)).toEqual(['ground', 'ground']);
  });
});
