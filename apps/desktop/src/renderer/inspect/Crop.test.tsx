// @vitest-environment jsdom
/**
 * The queue's zoomed crop: the suggestion's shape, in the pixels of the full-size photo, centred
 * in the crop with the photo around it. A normalized draft (`size` [1, 1]) and a draft in another
 * pixel grid frame the same spot as one in photo pixels.
 */
import type { Detection } from '@aio/annotate/detections';
import type { Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  frameImage: vi.fn(() =>
    Promise.resolve({ dataUrl: 'data:image/jpeg;base64,FRAME', width: 1920, height: 1080 }),
  ),
}));
vi.mock('../detections/prepare', () => ({ frameImage: h.frameImage }));

const { Crop, CROP_PAD } = await import('./Crop');

const NOW = '2026-10-15T10:00:00.000Z';

const D: Detection = {
  id: 'd1',
  pass: 'ai-r1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [4000, 3000],
  geom: { type: 'box', x: 2000, y: 1500, w: 400, h: 300 },
  classId: 'corrosion',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
  createdAt: NOW,
  updatedAt: NOW,
};

const LAYERS: Layer[] = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [{ id: 'p001', src: { path: 'photos/p001.jpg' } }],
  },
  {
    kind: 'video',
    id: 'v1',
    name: 'Clip',
    visible: true,
    src: { path: 'videos/clip.mp4' },
  } as Layer,
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

async function show(detection: Detection, imageSize: readonly [number, number] | null) {
  await act(async () => {
    root.render(
      <Crop
        projectId="p1"
        detection={detection}
        imageSize={imageSize}
        width={300}
        height={200}
        layers={LAYERS}
      />,
    );
    await Promise.resolve();
  });
}

const crop = () => host.querySelector<HTMLElement>('[data-testid="queue-crop"]');
const box = () => host.querySelector<HTMLElement>('[data-testid="queue-crop-box"]');
const px = (v: string | undefined) => Number.parseFloat(v ?? 'NaN');

/** Where the same box (2000, 1500, 400 x 300 photo px) sits in a 300 x 200 crop. */
function expected() {
  const s = 300 / Math.max(400 * CROP_PAD, 300 * CROP_PAD * (300 / 200));
  return { s, left: 150 - 200 * s, top: 100 - 150 * s, w: 400 * s, h: 300 * s };
}

function expectCentred() {
  const e = expected();
  expect(px(box()?.style.left)).toBeCloseTo(e.left, 3);
  expect(px(box()?.style.top)).toBeCloseTo(e.top, 3);
  expect(px(box()?.style.width)).toBeCloseTo(e.w, 3);
  expect(px(box()?.style.height)).toBeCloseTo(e.h, 3);
  const [bx, by] = (crop()?.style.backgroundPosition ?? '').split(' ');
  expect(px(bx)).toBeCloseTo(150 - 2200 * e.s, 3);
  expect(px(by)).toBeCloseTo(100 - 1650 * e.s, 3);
  const [sw, sh] = (crop()?.style.backgroundSize ?? '').split(' ');
  expect(px(sw)).toBeCloseTo(4000 * e.s, 3);
  expect(px(sh)).toBeCloseTo(3000 * e.s, 3);
}

describe('Crop', () => {
  it('crops a draft in photo pixels around its box, the real photo behind it', async () => {
    await show(D, [4000, 3000]);
    expect(crop()?.style.backgroundImage).toContain('aio://project/p1/photos/p001.jpg');
    expectCentred();
  });

  it('crops a normalized draft at its place', async () => {
    await show(
      { ...D, size: [1, 1], geom: { type: 'box', x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
      [4000, 3000],
    );
    // box centre at (2200, 1650) image px; the box element sits centred in the crop
    expectCentred();
  });

  it('crops a draft in another pixel grid at its place', async () => {
    await show(
      { ...D, size: [2000, 1500], geom: { type: 'box', x: 1000, y: 750, w: 200, h: 150 } },
      [4000, 3000],
    );
    expectCentred();
  });

  it('draws no box for a normalized draft until the photo size is known', async () => {
    await show({ ...D, size: [1, 1], geom: { type: 'box', x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }, null);
    expect(box()).toBeNull();
  });

  it('shows a video frame for a frame source', async () => {
    await show(
      {
        ...D,
        source: { kind: 'frame', layer: 'v1', t: 12.5 },
        size: [1920, 1080],
        geom: { type: 'box', x: 900, y: 500, w: 120, h: 80 },
      },
      null,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.frameImage).toHaveBeenCalledWith('aio://project/p1/videos/clip.mp4', 12.5);
    expect(crop()?.style.backgroundImage).toContain('data:image/jpeg;base64,FRAME');
    expect(box()).not.toBeNull();
  });
});
