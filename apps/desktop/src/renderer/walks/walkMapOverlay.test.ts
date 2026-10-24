// @vitest-environment jsdom
import type { FitPin, WalkFit, WalkFitSample, XZ } from '@aio/geo';
import type { Vec3, WalkLayer } from '@aio/schema';
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import {
  beamConeTransform,
  MapBeamMarkers,
  mapColour,
  walkBeamMarker,
  pathStyle,
  resolveCssColour,
  walkMapOverlays,
  walkPreviewMapOverlay,
} from './walkMapOverlay';
import { MAP_INK } from '@aio/maps';
import { BEAM_PX, beamFanPath, beamHalfRad, type WalkViewNow } from './walkView';

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

describe('a walk of a lined-up date', () => {
  const shift = { eastM: 2, northM: -1 };
  const first = (o: { data: FeatureCollection | string } | null | undefined, kind: string) => {
    const g = features(o?.data ?? '').find((f) => f.properties?.kind === kind)?.geometry;
    return g?.type === 'LineString' ? g.coordinates[0] : g?.type === 'Point' ? g.coordinates : null;
  };

  it('draws a walk of a lined-up date shifted', () => {
    const [o] = walkMapOverlays(
      [{ layer: layer('walk-a'), fit: fit(), raw: null, shift }],
      proj,
      colour,
      { placingId: null },
    );
    // the walk starts at x 0, z 0 as measured: 2 m east and 1 m south of that on the map
    expect(first(o, 'line')).toEqual([2, 1]);
    const [plain] = walkMapOverlays(
      [{ layer: layer('walk-a'), fit: fit(), raw: null }],
      proj,
      colour,
      { placingId: null },
    );
    expect(first(plain, 'line')).toEqual([0, 0]);
    // the shape being placed takes the same shift (the Beam's is in its own test)
    const preview = walkPreviewMapOverlay(
      'walk-a',
      [
        [0, 0],
        [4, 0],
      ],
      proj,
      '#fff',
      false,
      false,
      shift,
    );
    expect(first(preview, 'preview')).toEqual([2, 1]);
  });
});

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

  it('the path has no position in it: the Beam shows where the walk is', () => {
    const walks = [{ layer: layer('walk-a'), fit: fit(), raw: null }];
    const path = walkMapOverlays(walks, proj, colour, { placingId: 'walk-a' });
    expect(path.map((o) => o.id)).toEqual(['walk-walk-a']);
    expect(features(path[0]?.data ?? '').some((f) => f.properties?.kind === 'now')).toBe(false);
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

describe('the Beam marker on the map', () => {
  const view = (over: Partial<WalkViewNow> = {}): WalkViewNow => ({
    t: 4,
    lookDeg: 33.6,
    pitchDeg: 0,
    fovDeg: 60,
    hfovDeg: 90,
    ...over,
  });
  const walk = { layer: layer('walk-a'), fit: fit(), raw: null };

  it('sits where the walk is at the view time, with its look, width and way of travel', () => {
    const m = walkBeamMarker(walk, proj, '#3a7bd5', view());
    expect(m).toEqual({
      layerId: 'walk-a',
      lonLat: [4, 8],
      lookDeg: 33.6,
      hfovDeg: 90,
      walkDeg: 0,
      colour: '#3a7bd5',
    });
    // a walk of a lined-up date sits where its date lies
    const shifted = walkBeamMarker(
      { ...walk, shift: { eastM: 2, northM: -1 } },
      proj,
      '#000',
      view(),
    );
    expect(shifted?.lonLat).toEqual([6, 9]);
    // a turned date turns the look and the walk's way with the track
    const turned = walkBeamMarker(
      {
        ...walk,
        shift: {
          eastM: 0,
          northM: 0,
          turn: { rotationDeg: 90, scale: 1, pivotE: 0, pivotN: 0, pivotX: 0, pivotZ: 0 },
        },
      },
      proj,
      '#000',
      view({ lookDeg: 100 }),
    );
    expect(turned?.lookDeg).toBeCloseTo(10, 9);
    expect(turned?.walkDeg).toBeCloseTo(((((m?.walkDeg ?? 0) - 90) % 360) + 360) % 360, 9);
    expect(walkBeamMarker(walk, proj, '#000', view({ t: NaN }))).toBeNull();
  });

  it('turns the cone to the look bearing less the map bearing, flattened by the pitch', () => {
    // the fan is drawn along +x (east on a north-up map): a look north turns it a quarter back
    expect(beamConeTransform(0, 0, 0)).toBe('scale(1 1) rotate(-90)');
    expect(beamConeTransform(90, 0, 0)).toBe('scale(1 1) rotate(0)');
    expect(beamConeTransform(90, 30, 0)).toBe('scale(1 1) rotate(-30)');
    expect(beamConeTransform(90, 0, 60)).toBe('scale(1 0.5) rotate(0)');
  });

  /** The slice of a MapLibre map the markers use: 1 px a "degree" times `zoom`. */
  function fakeMap() {
    const container = document.createElement('div');
    const handlers = new Map<string, Set<() => void>>();
    const cam = { zoom: 1, bearing: 0, pitch: 0 };
    return {
      cam,
      container,
      handlers,
      map: {
        getContainer: () => container,
        project: (ll: [number, number]) => ({ x: ll[0] * cam.zoom, y: -ll[1] * cam.zoom }),
        getBearing: () => cam.bearing,
        getPitch: () => cam.pitch,
        on: (type: string, fn: () => void) => {
          const set = handlers.get(type) ?? new Set();
          set.add(fn);
          handlers.set(type, set);
        },
        off: (type: string, fn: () => void) => {
          handlers.get(type)?.delete(fn);
        },
      },
      fire: (type: string) => {
        for (const fn of handlers.get(type) ?? []) fn();
      },
    };
  }

  it('draws one marker per playing walk, named for e2e, the cone as wide as the view', () => {
    const f = fakeMap();
    const markers = new MapBeamMarkers(f.map);
    const a = walkBeamMarker(walk, proj, '#3a7bd5', view());
    const b = walkBeamMarker(
      { ...walk, layer: layer('walk-b') },
      proj,
      '#d5843a',
      view({ lookDeg: null }),
    );
    if (!a || !b) throw new Error('fixture');
    markers.set([a, b]);
    const els = [...f.container.querySelectorAll<HTMLElement>('[data-testid="walk-beam"]')];
    expect(els.map((e) => e.dataset.layerId)).toEqual(['walk-a', 'walk-b']);
    expect(els[0]?.dataset.lookDeg).toBe('34');
    // a walk not placed yet has no look: a dot without a cone
    expect(els[1]?.dataset.lookDeg).toBeUndefined();
    expect(els[1]?.querySelector('[data-part="cone"]')).toBeNull();
    const fan = els[0]?.querySelector('[data-part="cone"] path');
    expect(fan?.getAttribute('d')).toBe(beamFanPath(BEAM_PX.reach, beamHalfRad(90)));
    expect(fan?.getAttribute('fill')).toMatch(/^url\(#walk-beam-/);
    expect(els[0]?.querySelector('circle[data-part="dot"]')?.getAttribute('fill')).toBe('#3a7bd5');
    // a narrower view narrows the cone
    markers.set([{ ...a, hfovDeg: 40 }]);
    expect(f.container.querySelectorAll('[data-testid="walk-beam"]')).toHaveLength(1);
    expect(f.container.querySelector('[data-part="cone"] path')?.getAttribute('d')).toBe(
      beamFanPath(BEAM_PX.reach, beamHalfRad(40)),
    );
    markers.dispose();
  });

  it('keeps its size on screen at every zoom and turns with the map', () => {
    const f = fakeMap();
    const markers = new MapBeamMarkers(f.map);
    const a = walkBeamMarker(walk, proj, '#3a7bd5', view({ lookDeg: 90 }));
    if (!a) throw new Error('fixture');
    markers.set([a]);
    const el = f.container.querySelector<HTMLElement>('[data-testid="walk-beam"]');
    const svg = el?.querySelector('svg');
    const size = () => [svg?.getAttribute('width'), svg?.getAttribute('height')];
    const before = size();
    expect(before).toEqual([String(2 * BEAM_PX.reach), String(2 * BEAM_PX.reach)]);
    expect(el?.style.transform).toBe('translate(4px, -8px)');
    // zoomed in eight times: the spot moves, the marker stays the same size
    f.cam.zoom = 8;
    f.fire('move');
    expect(el?.style.transform).toBe('translate(32px, -64px)');
    expect(size()).toEqual(before);
    expect(el?.querySelector('[data-part="cone"]')?.getAttribute('transform')).toBe(
      'scale(1 1) rotate(0)',
    );
    f.cam.bearing = 45;
    f.cam.pitch = 60;
    f.fire('move');
    expect(el?.querySelector('[data-part="cone"]')?.getAttribute('transform')).toBe(
      'scale(1 0.5) rotate(-45)',
    );
    markers.dispose();
    expect(f.container.querySelector('[data-testid="walk-beam"]')).toBeNull();
    expect([...f.handlers.values()].every((h) => h.size === 0)).toBe(true);
  });
});
