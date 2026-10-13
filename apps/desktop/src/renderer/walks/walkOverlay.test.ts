import {
  surfaceFrameFromCorners,
  type FitPin,
  type SurfaceFrame,
  type WalkFit,
  type WalkFitSample,
  type XZ,
} from '@aio/geo';
import type { WalkLayer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  previewOnSheet,
  sheetHeading,
  toSheet,
  walkDrawingsForSheet,
  walkNowOnSheet,
  walkPinPoints,
  type SheetWalk,
} from './walkOverlay';

/** A drawing 1000 x 800 px at 0.05 m per px, turned a little and mirrored in y (y down = +z). */
const sheet: SurfaceFrame = {
  a: 0.05 * Math.cos(0.3),
  b: -0.05 * Math.sin(0.3),
  c: 0.05 * Math.sin(0.3),
  d: 0.05 * Math.cos(0.3),
  tx: 12,
  tz: -7,
  baseY: 0,
  provisional: false,
};
const size = { width: 1000, height: 800 };

const toModel = (f: SurfaceFrame, [px, py]: [number, number]): XZ => [
  f.a * px + f.b * py + f.tx,
  f.c * px + f.d * py + f.tz,
];

/** A walk that goes east 1 m a second from the sheet's origin, dashed between 5 s and 8 s. */
function fakeFit(over: Partial<WalkFit> = {}, at?: (t: number) => XZ): WalkFit {
  const origin = toModel(sheet, [100, 100]);
  const pos = at ?? ((t: number): XZ => [origin[0] + t, origin[1]]);
  const pins: FitPin[] = [
    { index: 0, t: 0, target: pos(0), active: true, residualM: null },
    { index: 1, t: 10, target: pos(10), active: true, residualM: null },
  ];
  return {
    at: (t: number): WalkFitSample => ({
      xz: pos(t),
      groundY: 0,
      headingRad: -Math.PI / 2,
      dashed: t > 5 && t < 8,
    }),
    pins,
    gaps: [{ fromT: 5, toT: 8 }],
    pinsOnly: false,
    notToScale: false,
    error: null,
    ...over,
  };
}

function walkLayer(id: string, over: Partial<WalkLayer> = {}): WalkLayer {
  return {
    kind: 'walk',
    id,
    name: id,
    visible: true,
    record: { path: `walks/${id}/walk.json` },
    src: { path: `walks/${id}/video.mp4` },
    durationS: 10,
    place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good' },
    ...over,
  };
}

const colour = () => 'var(--date-2)';
const opts = { placingId: null, size };

describe('toSheet', () => {
  it('toSheet inverts the drawing affine', () => {
    for (const px of [
      [0, 0],
      [123.25, 456.5],
      [1000, 800],
      [-30, 2000],
    ] as [number, number][]) {
      const back = toSheet(sheet, toModel(sheet, px));
      expect(Math.abs(back[0] - px[0])).toBeLessThan(1e-9);
      expect(Math.abs(back[1] - px[1])).toBeLessThan(1e-9);
    }
  });

  it('gives no point for a flat affine', () => {
    const flat = { ...sheet, a: 0, b: 0 };
    expect(toSheet(flat, [1, 2]).every(Number.isFinite)).toBe(false);
  });

  it('turns the model heading into a direction on the sheet', () => {
    // an unturned sheet with y down = +z: north (-z) is up on the sheet (-y), east is +x
    const plain = { ...sheet, a: 0.1, b: 0, c: 0, d: 0.1 };
    expect(sheetHeading(plain, 0)).toBeCloseTo(-Math.PI / 2, 9);
    expect(sheetHeading(plain, -Math.PI / 2)).toBeCloseTo(0, 9);
  });
});

describe('walkDrawingsForSheet', () => {
  const walk = (id: string, over: Partial<WalkLayer> = {}, fit = fakeFit()): SheetWalk => ({
    layer: walkLayer(id, over),
    fit,
    raw: null,
  });

  it('splits the line at a gap and marks it dashed', () => {
    const [d] = walkDrawingsForSheet([walk('walk-a')], sheet, colour, opts);
    expect(d?.line.map((l) => l.dashed)).toEqual([false, true, false]);
    // the runs join: each starts where the last one ended
    const [first, gap, last] = d?.line ?? [];
    expect(gap?.pts[0]).toEqual(first?.pts.at(-1));
    expect(last?.pts[0]).toEqual(gap?.pts.at(-1));
    // in image pixels: the start is the sheet point the walk began on
    const start = first?.pts[0] ?? [0, 0];
    expect(start[0]).toBeCloseTo(100, 6);
    expect(start[1]).toBeCloseTo(100, 6);
    expect(d?.colour).toBe('var(--date-2)');
    expect(d?.id).toBe('walk-a');
  });

  it('draws a walk on every drawing, not only its own', () => {
    // the walk was placed with a pin on another drawing; it still shows on this one
    const placed = walk('walk-a', {
      place: {
        pins: [
          { t: 0, surface: 'raster-other', at: [5, 5] },
          { t: 10, surface: 'raster-other', at: [50, 5] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality: 'good',
      },
    });
    const out = walkDrawingsForSheet([placed], sheet, colour, opts);
    expect(out).toHaveLength(1);
    expect(out[0]?.line.length).toBeGreaterThan(0);
  });

  it('hides unplaced walks except the one being placed', () => {
    const walks = [
      walk('walk-a', { place: undefined }),
      walk('walk-b', {
        place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'unplaced' },
      }),
      walk('walk-c'),
    ];
    expect(walkDrawingsForSheet(walks, sheet, colour, opts).map((d) => d.id)).toEqual(['walk-c']);
    expect(
      walkDrawingsForSheet(walks, sheet, colour, { ...opts, placingId: 'walk-b' }).map((d) => d.id),
    ).toEqual(['walk-b', 'walk-c']);
  });

  it('hides walks that are switched off', () => {
    const walks = [walk('walk-a', { visible: false }), walk('walk-b'), walk('walk-c')];
    const shown = walkDrawingsForSheet(walks, sheet, colour, {
      ...opts,
      hidden: new Set(['walk-c']),
    });
    expect(shown.map((d) => d.id)).toEqual(['walk-b']);
  });

  it('drops points outside a generous sheet bound (no huge SVG paths)', () => {
    // 1 km a second: from t = 2 the walk is far off the 50 m sheet
    const origin = toModel(sheet, [100, 100]);
    const far = fakeFit({}, (t) => [origin[0] + (t < 2 ? t : 1000 * t), origin[1]]);
    const [d] = walkDrawingsForSheet([walk('walk-a', {}, far)], sheet, colour, opts);
    const pts = d?.line.flatMap((l) => l.pts) ?? [];
    expect(pts.length).toBeGreaterThan(0);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1.5 * size.width);
      expect(x).toBeLessThanOrEqual(2.5 * size.width);
      expect(y).toBeGreaterThanOrEqual(-1.5 * size.height);
      expect(y).toBeLessThanOrEqual(2.5 * size.height);
    }
    // a line of one point is no line
    for (const l of d?.line ?? []) expect(l.pts.length).toBeGreaterThan(1);
  });

  it('shows pins only for the walk being placed', () => {
    const walks = [walk('walk-a'), walk('walk-b')];
    const out = walkDrawingsForSheet(walks, sheet, colour, { ...opts, placingId: 'walk-a' });
    const a = out.find((d) => d.id === 'walk-a');
    const b = out.find((d) => d.id === 'walk-b');
    expect(a?.pins.map((p) => p.n)).toEqual([1, 2]);
    expect(a?.pins.map((p) => p.index)).toEqual([0, 1]);
    expect(a?.pins[0]?.at[0]).toBeCloseTo(100, 6);
    expect(a?.placing).toBe(true);
    expect(b?.pins).toEqual([]);
    expect(b?.placing).toBe(false);
  });

  it('draws an inactive pin where the walk was at its time', () => {
    const base = fakeFit();
    const fit = fakeFit({
      pins: base.pins.map((p) => (p.index === 1 ? { ...p, target: [0, 0], active: false } : p)),
    });
    const [d] = walkDrawingsForSheet([walk('walk-a', {}, fit)], sheet, colour, {
      ...opts,
      placingId: 'walk-a',
    });
    const pin = d?.pins.find((p) => p.index === 1);
    expect(pin?.active).toBe(false);
    const want = toSheet(sheet, base.at(10)?.xz ?? [0, 0]);
    expect(pin?.at[0]).toBeCloseTo(want[0], 6);
  });

  it('gives the current position apart from the drawing, at the time asked', () => {
    const w = walk('walk-a');
    const now = walkNowOnSheet(w, sheet, colour, 3, size);
    expect(now?.id).toBe('walk-a');
    expect(now?.colour).toBe('var(--date-2)');
    const want = toSheet(sheet, fakeFit().at(3)?.xz ?? [0, 0]);
    expect(now?.at[0]).toBeCloseTo(want[0], 6);
    expect(now?.at[1]).toBeCloseTo(want[1], 6);
    expect(now?.headingRad).toBeCloseTo(sheetHeading(sheet, -Math.PI / 2), 9);
    expect(walkNowOnSheet(w, sheet, colour, null, size)).toBeNull();
    // the fit is not placed yet
    const unplaced = { ...w, fit: { ...w.fit, at: () => null } };
    expect(walkNowOnSheet(unplaced, sheet, colour, 3, size)).toBeNull();
  });
});

describe('roles and the preview', () => {
  const pinAt = (t: number, target: XZ): FitPin => ({
    index: t,
    t,
    target,
    active: true,
    residualM: null,
  });
  it('names the first pin Start and the last End; inner pins stay pins', () => {
    const three = fakeFit({
      pins: [pinAt(4, [0, 0]), pinAt(30, [20, 0]), pinAt(62, [40, -30])],
    });
    expect(walkPinPoints(three).map((p) => p.role)).toEqual(['start', 'pin', 'end']);
    expect(walkPinPoints(fakeFit({ pins: [pinAt(4, [0, 0])] })).map((p) => p.role)).toEqual([
      'start',
    ]);
  });

  it('puts the preview on the sheet in picture px', () => {
    const frame = surfaceFrameFromCorners(
      { tl: [-40, 0, -20], tr: [40, 0, -20], bl: [-40, 0, 20] },
      [400, 200],
      false,
    );
    const p = previewOnSheet(
      [
        [0, 0],
        [40, -20],
      ],
      frame,
      true,
      false,
    );
    expect(p.pts[0]?.[0]).toBeCloseTo(200);
    expect(p.pts[0]?.[1]).toBeCloseTo(100);
    expect(p.pts[1]?.[1]).toBeCloseTo(0);
    expect(p.ghost).toBe(true);
  });
});
