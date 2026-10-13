import type { FitPin, WalkFit, WalkFitSample, XZ } from '@aio/geo';
import type { Vec3, WalkLayer } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import {
  mapColour,
  pathStyle,
  resolveCssColour,
  walkMapOverlays,
  walkPreviewMapOverlay,
  walkNowMapOverlay,
} from './walkMapOverlay';
import { MAP_INK } from '@aio/maps';

const pos = (t: number): XZ => [t, 2 * t];
function fit(): WalkFit {
  const pins: FitPin[] = [
    { index: 1, t: 0, target: pos(0), active: true, residualM: null },
    { index: 0, t: 10, target: pos(10), active: true, residualM: null },
  ];
  return {
    at: (t: number): WalkFitSample => ({
      xz: pos(t),
      groundY: 0,
      headingRad: 0,
      dashed: t > 5 && t < 8,
    }),
    pins,
    gaps: [],
    pinsOnly: false,
    notToScale: false,
    error: null,
  };
}

const layer = (id: string, over: Partial<WalkLayer> = {}): WalkLayer => ({
  kind: 'walk',
  id,
  name: id,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/video.mp4` },
  durationS: 10,
  place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good' },
  ...over,
});

// metres to "degrees" one to one, so the coordinates are easy to read
const proj = {
  toLonLat: (v: Vec3 | readonly [number, number, number]): [number, number] => [v[0], v[2]],
};
const colour = () => '#3a7bd5';

const features = (data: FeatureCollection | string): Feature[] =>
  typeof data === 'string' ? [] : data.features;

describe('walkMapOverlays', () => {
  it('map overlay: a line layer, a circle layer for stills, one for pins, in the date colour', () => {
    const [o] = walkMapOverlays([{ layer: layer('walk-a'), fit: fit(), raw: null }], proj, colour, {
      placingId: 'walk-a',
    });
    expect(o?.id).toBe('walk-walk-a');
    const types = (o?.layers ?? []).map((l) => `${l.type}:${l.id}`);
    expect(types).toEqual(
      expect.arrayContaining(['line:line', 'line:line-dashed', 'circle:stills', 'circle:pins']),
    );
    for (const l of o?.layers ?? []) {
      const paint = JSON.stringify(l.paint ?? {});
      if (l.type === 'line' || l.id === 'stills' || l.id === 'pins')
        expect(paint).toContain('#3a7bd5');
    }
    const fs = features(o?.data ?? '');
    const lines = fs.filter((f) => f.properties?.kind === 'line');
    expect(lines.map((f): unknown => f.properties?.dashed)).toEqual([false, true, false]);
    const first = lines[0]?.geometry;
    expect(first?.type === 'LineString' ? first.coordinates[0] : null).toEqual([0, 0]);
    const pins = fs.filter((f) => f.properties?.kind === 'pin');
    expect(pins.map((f): unknown => f.properties?.n)).toEqual([1, 2]);
  });

  it('keeps pins and the position to the walk being placed, and dims the others', () => {
    const out = walkMapOverlays(
      [
        { layer: layer('walk-a'), fit: fit(), raw: null },
        { layer: layer('walk-b', { place: undefined }), fit: fit(), raw: null },
      ],
      proj,
      colour,
      { placingId: null },
    );
    // walk-b is not placed and not being placed
    expect(out.map((o) => o.id)).toEqual(['walk-walk-a']);
    const fs = features(out[0]?.data ?? '');
    expect(fs.some((f) => f.properties?.kind === 'pin' || f.properties?.kind === 'now')).toBe(
      false,
    );
    const line = out[0]?.layers.find((l) => l.id === 'line');
    expect(line?.paint?.['line-opacity']).toBe(0.6);
  });
});

describe('mapColour', () => {
  it('turns the oklch date tokens into hex for MapLibre', () => {
    expect(mapColour('oklch(0.68 0.14 250)')).toMatch(/^#[0-9a-f]{6}$/);
    expect(mapColour('oklch(68% 0.14 250)')).toBe(mapColour('oklch(0.68 0.14 250)'));
    expect(mapColour('#123456')).toBe('#123456');
  });
});

describe('the map redraws only what changed', () => {
  it('pathStyle: the same colour and state give the same style array', () => {
    expect(pathStyle('#3a7bd5', true)).toBe(pathStyle('#3a7bd5', true));
    expect(pathStyle('#3a7bd5', true)).not.toBe(pathStyle('#3a7bd5', false));
    const walks = [{ layer: layer('walk-a'), fit: fit(), raw: null }];
    const a = walkMapOverlays(walks, proj, colour, { placingId: null });
    const b = walkMapOverlays(walks, proj, colour, { placingId: null });
    expect(a[0]?.layers).toBe(b[0]?.layers);
  });

  it('the position is its own overlay: a new time leaves the path overlay alone', () => {
    const walks = [{ layer: layer('walk-a'), fit: fit(), raw: null }];
    const path = walkMapOverlays(walks, proj, colour, { placingId: 'walk-a' });
    const w = walks[0];
    if (!w) throw new Error('no walk');
    const at2 = walkNowMapOverlay(w, proj, colour, 2);
    const at3 = walkNowMapOverlay(w, proj, colour, 3);
    expect(at2?.id).toBe('walk-walk-a-now');
    expect(at3?.layers).toBe(at2?.layers);
    const point = features(at3?.data ?? '').find((f) => f.properties?.kind === 'now')?.geometry;
    expect(point?.type === 'Point' ? point.coordinates : null).toEqual([3, 6]);
    // the path has no position in it, so it never needs a rebuild for the time
    expect(features(path[0]?.data ?? '').some((f) => f.properties?.kind === 'now')).toBe(false);
    expect(walkNowMapOverlay(w, proj, colour, null)).toBeNull();
  });
});

describe('colours MapLibre cannot read', () => {
  it('fall back to the map ink', () => {
    expect(mapColour('none')).toBe(MAP_INK.fg1);
    expect(mapColour('color-mix(in oklch, red, blue)')).toBe(MAP_INK.fg1);
    expect(mapColour('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    // no DOM here: an unset variable reads as empty
    const el = { style: {} } as unknown as Element;
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    expect(resolveCssColour('var(--date-9)', el)).toBe(MAP_INK.fg1);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'oklch(0.68 0.14 250)' }));
    expect(resolveCssColour('var(--date-1)', el)).toMatch(/^#[0-9a-f]{6}$/);
    vi.unstubAllGlobals();
  });
});

describe('the placing preview and pin roles', () => {
  it('the preview is its own overlay; its style stays the same object across hovers', () => {
    const a = walkPreviewMapOverlay(
      'walk-a',
      [
        [0, 0],
        [10, 0],
      ],
      proj,
      '#3366ff',
      false,
      false,
    );
    const b = walkPreviewMapOverlay(
      'walk-a',
      [
        [0, 0],
        [12, 1],
      ],
      proj,
      '#3366ff',
      false,
      false,
    );
    expect(a?.id).toBe('walk-walk-a-preview');
    expect(a?.layers).toBe(b?.layers);
    expect(a?.data).not.toBe(b?.data);
    expect(walkPreviewMapOverlay('walk-a', [[0, 0]], proj, '#3366ff', true, false)).toBeNull();
  });

  it('pins carry their role', () => {
    const [ov] = walkMapOverlays(
      [{ layer: layer('walk-a'), fit: fit(), raw: null }],
      proj,
      colour,
      {
        placingId: 'walk-a',
      },
    );
    const roles = features(ov?.data ?? '')
      .filter((f) => f.properties?.kind === 'pin')
      .map((f): unknown => f.properties?.role);
    expect(roles[0]).toBe('start');
    expect(roles.at(-1)).toBe('end');
  });
});
