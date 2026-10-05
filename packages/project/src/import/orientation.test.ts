import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImageGeom, Issue } from '@aio/schema';
import sharp from 'sharp';
import {
  confidentMatch,
  kitThumbTurn,
  matchTurn,
  orientationProbe,
  turnImage,
  turnImageGeom,
  turnIssueSightings,
  turnPoint,
  turnProbe,
  turnedSize,
  type QuarterTurns,
} from './orientation';

/** Corners of a box or rotated box, clockwise from its rotated top-left (as annotate). */
function corners(g: Extract<ImageGeom, { type: 'box' | 'rotbox' }>): [number, number][] {
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  const r = ((g.type === 'rotbox' ? g.angleDeg : 0) * Math.PI) / 180;
  const at = (dx: number, dy: number): [number, number] => [
    cx + dx * Math.cos(r) - dy * Math.sin(r),
    cy + dx * Math.sin(r) + dy * Math.cos(r),
  ];
  return [
    at(-g.w / 2, -g.h / 2),
    at(g.w / 2, -g.h / 2),
    at(g.w / 2, g.h / 2),
    at(-g.w / 2, g.h / 2),
  ];
}

const sortPts = (p: [number, number][]) =>
  p
    .map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));

describe('turning pixel coordinates', () => {
  it('turns points of a 480 x 360 image', () => {
    expect(turnPoint(10, 20, 0, 480, 360)).toEqual([10, 20]);
    expect(turnPoint(10, 20, 2, 480, 360)).toEqual([470, 340]);
    // a quarter turn clockwise: the left edge becomes the top edge
    expect(turnPoint(0, 360, 1, 480, 360)).toEqual([0, 0]);
    expect(turnPoint(10, 20, 1, 480, 360)).toEqual([340, 10]);
    expect(turnPoint(10, 20, 3, 480, 360)).toEqual([20, 470]);
    expect(turnedSize(480, 360, 1)).toEqual([360, 480]);
  });

  it('four quarter turns and two half turns are the identity', () => {
    let p: [number, number] = [123.5, 45.25];
    let [w, h] = [480, 360];
    for (let i = 0; i < 4; i++) {
      p = turnPoint(p[0], p[1], 1, w, h);
      [w, h] = [h, w];
    }
    expect(p).toEqual([123.5, 45.25]);
    const once = turnPoint(123.5, 45.25, 2, 480, 360);
    expect(turnPoint(once[0], once[1], 2, 480, 360)).toEqual([123.5, 45.25]);
  });

  it('turns a box half way round: the F13 blister box on 102_0064', () => {
    const box: ImageGeom = { type: 'box', x: 209.8, y: 149.2, w: 197.4, h: 182.9 };
    expect(turnImageGeom(box, 2, 480, 360)).toEqual({
      type: 'box',
      x: 72.8,
      y: 27.9,
      w: 197.4,
      h: 182.9,
    });
  });

  it('turns every shape so its corners land where the turned pixels are', () => {
    const shapes: ImageGeom[] = [
      { type: 'box', x: 30, y: 40, w: 100, h: 50 },
      { type: 'rotbox', x: 200, y: 100, w: 80, h: 30, angleDeg: 25 },
    ];
    for (const t of [1, 2, 3] as QuarterTurns[]) {
      for (const g of shapes) {
        const out = turnImageGeom(g, t, 480, 360);
        if (out.type !== 'box' && out.type !== 'rotbox') throw new Error('shape changed');
        if (g.type !== 'box' && g.type !== 'rotbox') throw new Error('shape changed');
        const expected = corners(g).map(([x, y]) => turnPoint(x, y, t, 480, 360));
        expect(sortPts(corners(out))).toEqual(sortPts(expected));
      }
    }
    const poly: ImageGeom = {
      type: 'polygon',
      points: [
        [0, 0],
        [10, 0],
        [10, 5],
      ],
    };
    expect(turnImageGeom(poly, 2, 480, 360)).toEqual({
      type: 'polygon',
      points: [
        [480, 360],
        [470, 360],
        [470, 355],
      ],
    });
    expect(turnImageGeom({ type: 'point', x: 640, y: 480 }, 2, 1280, 960)).toEqual({
      type: 'point',
      x: 640,
      y: 480,
    });
    const mask: ImageGeom = { type: 'mask', src: { path: 'masks/a.png' } };
    expect(turnImageGeom(mask, 2, 480, 360)).toBe(mask);
  });

  it('rescales after the turn when the new photo has another size', () => {
    const box: ImageGeom = { type: 'box', x: 0, y: 0, w: 48, h: 36 };
    expect(turnImageGeom(box, 2, 480, 360, 1280, 960)).toEqual({
      type: 'box',
      x: 1152,
      y: 864,
      w: 128,
      h: 96,
    });
  });

  it('turns only the image sightings on turned photos of the layer', () => {
    const base = {
      classId: 'c',
      severityModelId: 's',
      severity: 3,
      status: 'draft',
      title: 't',
      createdAt: '2026-10-04T03:01:49.936Z',
      updatedAt: '2026-10-04T03:01:49.936Z',
    } as const;
    const issues = [
      {
        ...base,
        id: 'a',
        code: 'F13',
        sightings: [
          {
            on: 'image',
            layer: 'photos',
            photo: '102_0064',
            geom: { type: 'box', x: 209.8, y: 149.2, w: 197.4, h: 182.9 },
          },
          { on: 'image', layer: 'photos', photo: '101_0007', geom: { type: 'point', x: 1, y: 1 } },
        ],
      },
      { ...base, id: 'b', code: 'F12', sightings: [] },
    ] as unknown as Issue[];
    const r = turnIssueSightings(
      issues,
      'photos',
      new Map([['102_0064', { turn: 2 as const, width: 480, height: 360 }]]),
    );
    expect(r.changes.map((c) => [c.code, c.photo])).toEqual([['F13', '102_0064']]);
    expect(r.issues[0]?.sightings[0]).toMatchObject({ geom: { x: 72.8, y: 27.9 } });
    expect(r.issues[0]?.sightings[1]).toBe(issues[0]?.sightings[1]);
    expect(r.issues[1]).toBe(issues[1]);
  });
});

describe('finding the turn from pixels', () => {
  let dir = '';
  /** A test image with an asymmetric pattern: a bright block top-left, a gradient. */
  const pattern = (w: number, h: number) => {
    const px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const v = x < w / 3 && y < h / 3 ? 250 : Math.round((x / w) * 120 + (y / h) * 60);
        px[i] = v;
        px[i + 1] = v;
        px[i + 2] = (x * 7 + y * 3) % 50;
      }
    return sharp(px, { raw: { width: w, height: h, channels: 3 } });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aio-orient-'));
    await pattern(320, 240).jpeg().toFile(join(dir, 'full.jpg'));
    // the thumbnail as the HCl kit made it: the same picture upside down
    await pattern(320, 240).rotate(180).resize(96).jpeg().toFile(join(dir, 'thumb.jpg'));
    // a camera original that stores its pixels upside down with EXIF Orientation 3
    await pattern(320, 240)
      .rotate(180)
      .jpeg()
      .withMetadata({ orientation: 3 })
      .toFile(join(dir, 'original.jpg'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns a probe like the pixels', async () => {
    const p = await orientationProbe(join(dir, 'full.jpg'));
    const t = turnProbe(turnProbe(p, 1), 3);
    expect(Array.from(t.data)).toEqual(Array.from(p.data));
  });

  it('sees that a kit thumbnail is upside down against its full copy', async () => {
    const m = matchTurn(
      await orientationProbe(join(dir, 'thumb.jpg')),
      await orientationProbe(join(dir, 'full.jpg')),
    );
    expect(m.turn).toBe(2);
    expect(confidentMatch(m)).toBe(true);
    const same = matchTurn(
      await orientationProbe(join(dir, 'full.jpg')),
      await orientationProbe(join(dir, 'full.jpg')),
    );
    expect(same.turn).toBe(0);
  });

  it('applies EXIF Orientation of a camera original when asked', async () => {
    const full = await orientationProbe(join(dir, 'full.jpg'));
    expect(matchTurn(full, await orientationProbe(join(dir, 'original.jpg'), true)).turn).toBe(0);
    expect(matchTurn(full, await orientationProbe(join(dir, 'original.jpg'))).turn).toBe(2);
  });

  it('turns the pixels so the thumbnail matches again', async () => {
    const turned = await turnImage(join(dir, 'thumb.jpg'), 2);
    const m = matchTurn(
      await orientationProbe(turned),
      await orientationProbe(join(dir, 'full.jpg')),
    );
    expect(m.turn).toBe(0);
    expect((await sharp(turned).metadata()).format).toBe('jpeg');
  });

  it('decides the kit thumbnail turn from the pairs', async () => {
    const pair = { full: join(dir, 'full.jpg'), thumb: join(dir, 'thumb.jpg') };
    expect(await kitThumbTurn([pair, pair])).toEqual({ turn: 2, pairs: 2, agree: 2 });
    expect(await kitThumbTurn([])).toBeNull();
    const right = { full: join(dir, 'full.jpg'), thumb: join(dir, 'full.jpg') };
    expect(await kitThumbTurn([pair, right])).toBeNull();
  });
});
