import type { GcpFile, GcpPoint } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  adjustProblems,
  applyMark,
  clickToPixel,
  gcpLocal,
  gcpLonLat,
  loupeBackground,
  photosFor,
  predictions,
  readCamerasFile,
  sfmPhotos,
  step,
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
