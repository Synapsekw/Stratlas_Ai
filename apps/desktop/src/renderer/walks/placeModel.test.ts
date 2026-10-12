import { ProjectManifest, type Capture, type WalkLayer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  dateChoices,
  firstStep,
  placeSurfaces,
  rememberedSurface,
  surfaceFramesOf,
} from './placeModel';

const captures: Capture[] = [
  { id: 'c2', label: 'Second', date: '2026-02-01' },
  { id: 'c1', label: 'First', date: '2026-01-01' },
];

const plan = (id: string, name: string, capture?: string, corners = true) => ({
  kind: 'raster' as const,
  id,
  name,
  ...(capture ? { capture } : {}),
  src: { path: `drawings/${id}/plan.png` },
  role: 'plan' as const,
  format: 'image' as const,
  ...(corners
    ? {
        corners: {
          tl: [10, 2, 20] as [number, number, number],
          tr: [110, 2, 20] as [number, number, number],
          bl: [10, 2, 70] as [number, number, number],
        },
      }
    : {}),
});

function manifest(): ProjectManifest {
  return ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [0, 0, 0],
    captures,
    layers: [
      plan('sheet-other', 'Plan other', 'c2'),
      plan('sheet-none', 'Plan loose'),
      plan('sheet-own', 'Plan own', 'c1'),
      plan('sheet-bare', 'Plan bare', undefined, false),
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Ortho',
        capture: 'c1',
        src: { path: 'o.tif' },
        role: 'ortho',
        format: 'cog',
      },
    ],
    severityModels: [],
    classCatalogues: [],
  });
}

function walk(extra: Partial<WalkLayer> = {}): WalkLayer {
  return {
    kind: 'walk',
    id: 'walk-a',
    name: 'Walk A',
    visible: true,
    record: { path: 'walks/a/walk.json' },
    src: { path: 'walks/a/playback.mp4' },
    durationS: 62,
    ...extra,
  };
}

describe('placeSurfaces', () => {
  it('offers no Map without a CRS', () => {
    const s = placeSurfaces(manifest(), walk({ capture: 'c1' }), false);
    expect(s.some((x) => x.kind === 'map')).toBe(false);
    expect(placeSurfaces(manifest(), walk({ capture: 'c1' }), true).at(-1)).toEqual({
      kind: 'map',
    });
  });

  it("lists the walk's date drawings, then undated ones, then Map", () => {
    expect(placeSurfaces(manifest(), walk({ capture: 'c1' }), true)).toEqual([
      { kind: 'drawing', id: 'sheet-own', name: 'Plan own', dated: true },
      { kind: 'drawing', id: 'sheet-none', name: 'Plan loose', dated: false },
      { kind: 'map' },
    ]);
  });

  it('remembers the last surface by placedOn', () => {
    const w = walk({
      capture: 'c1',
      place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'unplaced', placedOn: '@model' },
    });
    expect(rememberedSurface(w, placeSurfaces(manifest(), w, true))).toEqual({ kind: 'map' });
    expect(rememberedSurface(w, placeSurfaces(manifest(), w, false))).toBeNull();
  });
});

describe('surfaceFramesOf', () => {
  it('maps image px through the corners, base height from the top-left corner', () => {
    const frames = surfaceFramesOf(manifest(), (id) =>
      id === 'sheet-own' ? { provisional: true, size: { width: 1000, height: 500 } } : undefined,
    );
    expect(frames.drawing('sheet-own')).toEqual({
      a: 0.1,
      b: 0,
      c: 0,
      d: 0.1,
      tx: 10,
      tz: 20,
      baseY: 2,
      provisional: true,
    });
  });

  it('has no frame without a known size, without corners or for another kind', () => {
    const frames = surfaceFramesOf(manifest(), () => ({
      provisional: false,
      size: { width: 10, height: 10 },
    }));
    expect(frames.drawing('sheet-bare')).toBeNull();
    expect(frames.drawing('ortho')).toBeNull();
    expect(frames.drawing('gone')).toBeNull();
    expect(surfaceFramesOf(manifest(), () => undefined).drawing('sheet-own')).toBeNull();
  });
});

describe('firstStep', () => {
  it('starts at the date step when the walk has no capture', () => {
    expect(firstStep(walk())).toBe('date');
    expect(firstStep(walk({ capture: 'c1' }))).toBe('surface');
  });
});

describe('dateChoices', () => {
  it('date choices: the capturedAt date first, add when missing', () => {
    expect(dateChoices(walk(), captures, '2026-02-01T10:00:00')).toEqual({ pick: ['c2', 'c1'] });
    expect(dateChoices(walk(), captures, '2026-03-05T08:30:00')).toEqual({
      pick: ['c1', 'c2'],
      add: '2026-03-05',
    });
    expect(dateChoices(walk(), captures)).toEqual({ pick: ['c1', 'c2'] });
    expect(dateChoices(walk(), [], '2026-03-05T08:30:00')).toEqual({
      pick: [],
      add: '2026-03-05',
    });
  });
});
