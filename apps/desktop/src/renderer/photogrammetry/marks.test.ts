import { worldToPixel } from '@aio/annotate';
import type { GcpFile, GcpPoint } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  adjustProblems,
  applyMark,
  clickToPixel,
  gcpLocal,
  gcpLonLat,
  GNSS_RADIUS_PX,
  groundShift,
  inFrame,
  loupeBackground,
  MARKED_RADIUS_PX,
  markerList,
  nextToMark,
  photosFor,
  predictions,
  readCamerasFile,
  sfmPhotos,
  step,
  surveyShift,
  triangulate,
  withPoint,
  type MarkerPhoto,
} from './marks';

const AT = '2026-10-07T10:00:00.000Z';
const point = (o: Partial<GcpPoint> = {}): GcpPoint => ({
  id: 'GCP1',
  role: 'control',
  xyz: [500000, 3200000, 10],
  accuracy: { horizontalM: 0.02, verticalM: 0.03 },
  marks: [],
  ...o,
});

/** A nadir camera: looking straight down (-Y in the local frame), image up towards north (-Z). */
const NADIR: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

describe('mark states', () => {
  it('confirms a person mark at once and keeps a detector mark a draft', () => {
    let p = applyMark(point(), { kind: 'place', photo: 'a', px: [10, 20] }, AT);
    expect(p.marks).toEqual([
      { photo: 'a', px: [10, 20], by: 'person', at: AT, state: 'confirmed' },
    ]);
    p = applyMark(p, { kind: 'place', photo: 'b', px: [1, 2], by: 'detector' }, AT);
    expect(p.marks[1]?.state).toBe('draft');
    p = applyMark(p, { kind: 'confirm', photo: 'b' }, AT);
    expect(p.marks[1]).toMatchObject({
      photo: 'b',
      px: [1, 2],
      by: 'detector',
      state: 'confirmed',
    });
  });

  it('confirms a prediction as a mark, skips a photo and clears a mark', () => {
    let p = applyMark(point(), { kind: 'confirm', photo: 'c', px: [800, 600] }, AT);
    expect(p.marks).toEqual([
      { photo: 'c', px: [800, 600], by: 'person', at: AT, state: 'confirmed' },
    ]);
    // nothing to confirm without a mark or a prediction
    expect(applyMark(point(), { kind: 'confirm', photo: 'x' }, AT).marks).toEqual([]);
    p = applyMark(p, { kind: 'skip', photo: 'c' }, AT);
    expect(p.marks).toEqual([
      { photo: 'c', px: [800, 600], by: 'person', at: AT, state: 'skipped' },
    ]);
    p = applyMark(p, { kind: 'clear', photo: 'c' }, AT);
    expect(p.marks).toEqual([]);
  });

  it('says what Adjust waits for', () => {
    const marked = (id: string, n: number, role: GcpPoint['role'] = 'control') =>
      point({
        id,
        role,
        marks: Array.from({ length: n }, (_, i) => ({
          photo: `p${String(i)}`,
          px: [0, 0] as [number, number],
          by: 'person' as const,
          at: AT,
          state: 'confirmed' as const,
        })),
      });
    const f: GcpFile = {
      schema: 'aio.gcp/1',
      crs: { epsg: 32639 },
      points: [marked('A', 3), marked('B', 3), marked('C', 1), marked('K', 0, 'check')],
    };
    expect(adjustProblems(f)).toEqual([
      'C: 1 of 3 marks confirmed. Mark it in 2 more photos, or disable it.',
    ]);
    const disabled = withPoint(f, { ...marked('C', 1), disabled: true });
    expect(adjustProblems(disabled)).toEqual(['Adjusting needs at least three control points.']);
    expect(adjustProblems(withPoint(f, marked('C', 4)))).toEqual([]);
  });
});

describe('predictions', () => {
  const frame = { epsg: 32639, origin: [500000, 3200000, 0] as [number, number, number] };

  it('places a GCP in the local frame from its own CRS or from WGS 84', () => {
    expect(gcpLocal(point(), 32639, frame)).toEqual([0, 10, 0]);
    const ll = gcpLonLat(point(), 32639);
    expect(ll?.[0]).toBeCloseTo(51, 5);
    const back = gcpLocal(point({ xyz: [ll?.[0] ?? 0, ll?.[1] ?? 0, 10] }), 4326, frame);
    expect(back?.[0]).toBeCloseTo(0, 3);
    expect(back?.[2]).toBeCloseTo(0, 3);
  });

  it('predicts the point under a nadir camera at the image centre, sorted by centre distance', () => {
    const photos: MarkerPhoto[] = [
      {
        id: 'off',
        size: [1600, 1200],
        pos: [10, 60, 0],
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 70, aspect: 4 / 3 },
      },
      {
        id: 'over',
        size: [1600, 1200],
        pos: [0, 60, 0],
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 70, aspect: 4 / 3 },
      },
      {
        id: 'far',
        size: [1600, 1200],
        pos: [500, 60, 0],
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 70, aspect: 4 / 3 },
      },
      { id: 'nopose', size: [1600, 1200] },
    ];
    const p = point({ xyz: [500000, 3200000, 0] });
    const preds = predictions(p, gcpLocal(p, 32639, frame), photos);
    expect(preds.map((x) => x.photo).sort()).toEqual(['off', 'over']);
    const over = preds.find((x) => x.photo === 'over');
    expect(over?.px[0]).toBeCloseTo(800, 6);
    expect(over?.px[1]).toBeCloseTo(600, 6);
    // the camera 10 m east sees the point left of centre
    expect(preds.find((x) => x.photo === 'off')?.px[0]).toBeLessThan(800);
    const order = photosFor(p, preds, photos).map((x) => x.photo.id);
    expect(order).toEqual(['over', 'off']);
  });

  it('prefers the run predictions, and lists marked photos without one last', () => {
    const photos: MarkerPhoto[] = [
      { id: 'a', size: [100, 100] },
      { id: 'b', size: [100, 100] },
    ];
    const p = point({
      predicted: [{ photo: 'a', px: [50, 50], radiusPx: 12 }],
      marks: [{ photo: 'b', px: [1, 1], by: 'person', at: AT, state: 'confirmed' }],
    });
    const preds = predictions(p, null, photos);
    expect(preds).toEqual([{ photo: 'a', px: [50, 50], radiusPx: 12 }]);
    expect(
      photosFor(p, preds, photos).map((x) => [x.photo.id, x.prediction?.radiusPx ?? null]),
    ).toEqual([
      ['a', 12],
      ['b', null],
    ]);
  });

  it('steps through a list and wraps', () => {
    expect(step(1, 3, 1)).toBe(2);
  });
});

/**
 * A flight without RTK, as `photo.align` leaves it before any ground control: the cameras sit
 * 25 m below the survey's height datum (the drone's logged altitude) and 2.5 m beside it (the GNSS
 * bias). Four nadir photos 60 m above the model's ground; the survey's ground is at 100 m.
 */
describe('predictions that learn from the marks', () => {
  const frame = { epsg: 32639, origin: [500000, 3200000, 0] as [number, number, number] };
  /** Cameras' frame minus survey, local metres (x east, y up, z south). */
  const SHIFT = [1.5, -25, -2] as const;
  const size: [number, number] = [960, 720];
  const lens = { model: 'pinhole' as const, hfovDeg: 74.32, aspect: 4 / 3 };
  const photos: MarkerPhoto[] = [-60, -30, 0, 30].map((x) => ({
    id: `x${String(x)}`,
    size,
    pos: [x, 135, 0],
    q: NADIR,
    lens,
  }));
  /** As the run states it: the depth of the model's ground (60 m) over the focal length. */
  const gsdCm = (60 / (480 / Math.tan((lens.hfovDeg * Math.PI) / 360))) * 100;
  const surveyed = (id: string, east: number, north: number, o: Partial<GcpPoint> = {}): GcpPoint =>
    point({ id, xyz: [500000 + east, 3200000 + north, 100], ...o });
  /** Where the target really is in a photo: the survey as the cameras' frame has it. */
  const truePx = (p: GcpPoint, ph: MarkerPhoto): [number, number] | null => {
    const l = gcpLocal(p, 32639, frame);
    if (!l || !ph.pos || !ph.q || !ph.lens) return null;
    const at: [number, number, number] = [l[0] + SHIFT[0], l[1] + SHIFT[1], l[2] + SHIFT[2]];
    return worldToPixel({ pos: ph.pos, q: ph.q }, ph.lens, at, ph.size);
  };
  const seenIn = (p: GcpPoint) => photos.filter((ph) => truePx(p, ph)).map((ph) => ph.id);
  /** The point marked by a person on its target in these photos. */
  const marked = (p: GcpPoint, ids: string[]): GcpPoint => ({
    ...p,
    marks: ids.map((id) => {
      const ph = photos.find((x) => x.id === id);
      const px = ph ? truePx(p, ph) : null;
      if (!px) throw new Error(`${p.id} is not in ${id}`);
      return { photo: id, px, by: 'person' as const, at: AT, state: 'confirmed' as const };
    }),
  });
  const file = (...points: GcpPoint[]): GcpFile => ({
    schema: 'aio.gcp/1',
    crs: { epsg: 32639 },
    points,
  });
  /** The largest distance of the predictions from the targets, pixels. */
  const worst = (
    p: GcpPoint,
    list: { photo: MarkerPhoto; prediction: { px: number[] } | null }[],
  ) =>
    Math.max(
      ...list.map(({ photo, prediction }) => {
        const t = truePx(p, photo);
        if (!t || !prediction) return Infinity;
        return Math.hypot((prediction.px[0] ?? NaN) - t[0], (prediction.px[1] ?? NaN) - t[1]);
      }),
    );
  const ids = (list: { photo: MarkerPhoto }[]) => list.map((x) => x.photo.id).sort();

  // 38 m west of the third photo: 95 px from its left edge
  const edge = surveyed('EDGE', -38, 0);
  const mid = surveyed('MID', -10, 5);

  it('as surveyed, a point is missed in a photo that sees it and its ring is far from the target', () => {
    expect(seenIn(edge)).toEqual(['x-60', 'x-30', 'x0']);
    const preds = predictions(edge, gcpLocal(edge, 32639, frame), photos);
    // 35 m below the cameras, not 60: every position is 1.7 times as far from the image centre
    expect(preds.map((x) => x.photo).sort()).toEqual(['x-30', 'x-60']);
    expect(worst(edge, photosFor(edge, preds, photos))).toBeGreaterThan(1.5 * GNSS_RADIUS_PX);
  });

  it("before any mark, puts the survey on the model's ground", () => {
    const f = file(edge, mid);
    const placed = f.points.map((p) => ({ point: p, local: gcpLocal(p, 32639, frame) }));
    const shift = groundShift(placed, photos, gsdCm);
    expect(shift?.[0]).toBe(0);
    expect(shift?.[1]).toBeCloseTo(-25, 6);
    expect(shift?.[2]).toBe(0);
    const list = markerList(f, edge, photos, frame, gsdCm);
    expect(ids(list)).toEqual(['x-30', 'x-60', 'x0']);
    // what is left is the GNSS bias: 2.5 m at 9.5 cm a pixel
    expect(worst(edge, list)).toBeLessThan(GNSS_RADIUS_PX / 2);
    expect(list.every((x) => x.prediction?.radiusPx === GNSS_RADIUS_PX)).toBe(true);

    // nothing to go by: no stated GSD, no photo that looks down, no point that can be placed
    expect(groundShift(placed, photos, undefined)).toBeNull();
    const level: MarkerPhoto[] = photos.map((ph) => ({ ...ph, q: [0, 0, 0, 1] }));
    expect(groundShift(placed, level, gsdCm)).toBeNull();
    expect(groundShift([{ point: edge, local: null }], photos, gsdCm)).toBeNull();
    expect(ids(markerList(f, edge, photos, frame))).toEqual(['x-30', 'x-60']);
  });

  it('triangulates a point from two marks and places it in every photo that sees it', () => {
    const p = marked(edge, ['x-60', 'x-30']);
    const local = gcpLocal(p, 32639, frame) ?? [0, 0, 0];
    const at = triangulate(p, photos);
    for (const k of [0, 1, 2] as const) expect(at?.[k]).toBeCloseTo(local[k] + SHIFT[k], 6);
    const list = markerList(file(p), p, photos, frame);
    expect(ids(list)).toEqual(['x-30', 'x-60', 'x0']);
    expect(worst(p, list)).toBeLessThan(1e-6);
    expect(list.every((x) => x.prediction?.radiusPx === MARKED_RADIUS_PX)).toBe(true);
    // the point's own marks say more than the run's predictions, written before them
    const stale = {
      ...p,
      predicted: [{ photo: 'x30', px: [1, 1] as [number, number], radiusPx: 9 }],
    };
    expect(ids(markerList(file(stale), stale, photos, frame))).toEqual(['x-30', 'x-60', 'x0']);
  });

  it('does not triangulate from one photo, a photo without a pose or rays close to parallel', () => {
    expect(triangulate(marked(edge, ['x-60']), photos)).toBeNull();
    const unposed: MarkerPhoto[] = photos.map((ph) =>
      ph.id === 'x-30' ? { id: ph.id, size } : ph,
    );
    expect(triangulate(marked(edge, ['x-60', 'x-30']), unposed)).toBeNull();
    // two photos half a metre apart: the rays cross at half a degree
    const near: MarkerPhoto[] = [
      { id: 'x-60', size, pos: [-60, 135, 0], q: NADIR, lens },
      { id: 'again', size, pos: [-59.5, 135, 0], q: NADIR, lens },
    ];
    const twice: GcpPoint = {
      ...edge,
      marks: near.map((ph) => ({
        photo: ph.id,
        px: truePx(edge, ph) ?? [0, 0],
        by: 'person' as const,
        at: AT,
        state: 'confirmed' as const,
      })),
    };
    expect(twice.marks[0]?.px[0]).not.toBeCloseTo(twice.marks[1]?.px[0] ?? 0, 1);
    expect(triangulate(twice, near)).toBeNull();
    // a skipped photo and a draft are not measurements
    const skipped = applyMark(marked(edge, ['x-60']), { kind: 'skip', photo: 'x-30' }, AT);
    expect(triangulate(skipped, photos)).toBeNull();
  });

  it('places the points not marked yet by what the marked ones say about the survey', () => {
    const done = marked(mid, ['x-30', 'x0']);
    const f = file(done, edge);
    const placed = f.points.map((p) => ({ point: p, local: gcpLocal(p, 32639, frame) }));
    const shift = surveyShift(placed, photos, gsdCm);
    for (const k of [0, 1, 2] as const) expect(shift?.[k]).toBeCloseTo(SHIFT[k], 6);
    const list = markerList(f, edge, photos, frame, gsdCm);
    expect(ids(list)).toEqual(['x-30', 'x-60', 'x0']);
    expect(worst(edge, list)).toBeLessThan(1e-5);
    expect(list.every((x) => x.prediction?.radiusPx === GNSS_RADIUS_PX)).toBe(true);
    // a point a person switched off says nothing: back to the model's ground
    const off = file({ ...done, disabled: true }, edge);
    expect(worst(edge, markerList(off, edge, photos, frame, gsdCm))).toBeGreaterThan(10);
    expect(ids(markerList(off, edge, photos, frame, gsdCm))).toEqual(['x-30', 'x-60', 'x0']);
  });

  it('offers a photo its ring reaches into, with nothing to confirm beside the frame', () => {
    // 27 px left of the third photo: beside the frame, inside the search ring
    const beside = surveyed('BESIDE', -49.5, 0);
    const f = file(marked(mid, ['x-30', 'x0']), beside);
    const list = markerList(f, beside, photos, frame, gsdCm);
    expect(ids(list)).toEqual(['x-30', 'x-60', 'x0']);
    const px = list.find((x) => x.photo.id === 'x0')?.prediction?.px ?? [0, 0];
    expect(px[0]).toBeCloseTo(-26.6, 1);
    expect(inFrame(px, size)).toBe(false);
    expect(inFrame(px, size, GNSS_RADIUS_PX)).toBe(true);
    // placed by its own marks the ring is 12 px: the photo is no longer offered
    const own = marked(beside, ['x-60', 'x-30']);
    expect(ids(markerList(file(own), own, photos, frame, gsdCm))).toEqual(['x-30', 'x-60']);
    expect(inFrame([0, 720], size)).toBe(true);
    expect(inFrame([960.5, 10], size)).toBe(false);
  });

  it('goes on to the next photo without a mark, in the list as the mark leaves it', () => {
    // as surveyed the third photo is not offered: after the second mark it is
    const one = marked(edge, ['x-30']);
    const before = markerList(file(one), one, photos, frame);
    expect(ids(before)).toEqual(['x-30', 'x-60']);
    expect(nextToMark(before, one, 'x-30')).toBe('x-60');
    const two = marked(edge, ['x-30', 'x-60']);
    const after = markerList(file(two), two, photos, frame);
    expect(nextToMark(after, two, 'x-60')).toBe('x0');
    // every photo marked or skipped: simply the next one; nothing in an empty list
    const all = applyMark(two, { kind: 'skip', photo: 'x0' }, AT);
    const full = markerList(file(all), all, photos, frame);
    const order = full.map((x) => x.photo.id);
    expect(nextToMark(full, all, order[0] ?? '')).toBe(order[1]);
    expect(nextToMark(full, all, order[2] ?? '')).toBe(order[0]);
    expect(nextToMark([], all, 'x0')).toBeNull();
  });
});

describe('pixel convention (COLMAP: top-left corner is 0, 0; pixel i has its centre at i + 0.5)', () => {
  // a 1600 x 1200 photo shown 800 x 600 CSS pixels at (100, 50) on screen
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  const size: [number, number] = [1600, 1200];

  it('turns a click into continuous original-image pixels', () => {
    expect(clickToPixel([100, 50], rect, size)).toEqual([0, 0]); // the image's top-left corner
    expect(clickToPixel([500, 350], rect, size)).toEqual([800, 600]); // the image centre
    expect(clickToPixel([900, 650], rect, size)).toEqual([1600, 1200]); // bottom-right corner
    // the middle of the first original pixel (half a screen pixel, at half scale) is 0.5, 0.5
    expect(clickToPixel([100.25, 50.25], rect, size)).toEqual([0.5, 0.5]);
    // outside the photo: held at its edge
    expect(clickToPixel([90, 700], rect, size)).toEqual([0, 1200]);
  });

  it('draws a mark where it was clicked and predicts a nadir point at width / 2, height / 2', () => {
    // the overlay's viewBox is the original size, so a mark at px draws at px / size of the photo
    const px = clickToPixel([300.5, 200.5], rect, size);
    expect([
      (px[0] / size[0]) * rect.width + rect.left,
      (px[1] / size[1]) * rect.height + rect.top,
    ]).toEqual([300.5, 200.5]);
    // COLMAP's principal point of an ideal camera is the image centre (cx = width / 2), which is
    // where G2 (gcp.py predictions) and G8 (truth.json) put a point straight below the camera
    const p = point({ xyz: [500000, 3200000, 0] });
    const frame = { epsg: 32639, origin: [500000, 3200000, 0] as [number, number, number] };
    const [pred] = predictions(p, gcpLocal(p, 32639, frame), [
      {
        id: 'n',
        size,
        pos: [0, 60, 0],
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 70, aspect: 4 / 3 },
      },
    ]);
    expect(pred?.px[0]).toBeCloseTo(800, 9);
    expect(pred?.px[1]).toBeCloseTo(600, 9);
  });

  it('puts the target under the loupe centre at any position', () => {
    // 140 px loupe at 4x: the photo is 560 x 420 px; the centre pixel sits at 70, 70
    expect(loupeBackground([800, 600], size, 140, 4)).toEqual({
      size: '560px 420px',
      position: '-210px -140px',
    });
    // the top-left corner: the photo starts at the loupe centre
    expect(loupeBackground([0, 0], size, 140, 4).position).toBe('70px 70px');
    expect(loupeBackground([1600, 1200], size, 140, 4).position).toBe('-490px -350px');
  });
});

describe('refined cameras of the run', () => {
  const file = {
    run: '20261007-0915',
    crs: { epsg: 32639 },
    origin: [500100, 3200050, 2] as [number, number, number],
    calibration: [{ id: 'cam1', model: 'OPENCV', width: 1600, height: 1200, params: [1, 2, 3, 4] }],
    cameras: [
      {
        photo: '100MEDIA/DJI_0001.JPG',
        pos: [0, 58, 0],
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 66, aspect: 4 / 3 },
        camera: 'cam1',
      },
    ],
  };

  it('reads G2 files without a schema key, sized by calibration, in the project frame', () => {
    const f = readCamerasFile(file);
    expect(f?.schema).toBe('aio.photo-cameras/1');
    expect(readCamerasFile({ ...file, schema: 'aio.photo-cameras/2' })).toBeNull();
    expect(readCamerasFile([1, 2])).toBeNull();
    if (!f) return;
    const m = sfmPhotos(f, [500000, 3200000, 0]);
    expect(m.get('100MEDIA/DJI_0001.JPG')).toMatchObject({
      id: '100MEDIA/DJI_0001.JPG',
      size: [1600, 1200],
      pos: [100, 60, -50],
      lens: { model: 'pinhole', hfovDeg: 66 },
    });
  });
});

describe('steps', () => {
  it('wraps', () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(-1);
  });
});
