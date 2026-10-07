import type { GcpFile, GcpPoint } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  adjustProblems,
  applyMark,
  gcpLocal,
  gcpLonLat,
  photosFor,
  predictions,
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
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(-1);
  });
});
