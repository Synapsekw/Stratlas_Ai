import type { Detection, DetectionsFile } from '@aio/schema';
import { captureIndex } from '@aio/workspace/captures';
import { describe, expect, it } from 'vitest';
import { detectionChanges, photoDetectionLocator } from './detections';
import { SITE } from './testing';

const det = (photo: string, cls: string, extra: Partial<Detection> = {}): Detection => ({
  photo,
  class: cls,
  bbox: [10, 10, 20, 20],
  ...extra,
});
const pass = (layer: string, detections: Detection[]): DetectionsFile => ({
  schema: 'aio.detections/1',
  source: 'human',
  layer,
  detections,
});

describe('detection change per class and zone', () => {
  const index = captureIndex(SITE);
  const items = detectionChanges({
    manifest: SITE,
    index,
    from: 'd1',
    to: 'd2',
    passes: [
      {
        name: 'first.json',
        file: pass('photos-d1', [
          det('photos-d1-0', 'corrosion', { id: 'a', component: 'T-101' }),
          det('photos-d1-1', 'corrosion', { id: 'b', component: 'T-101' }),
          det('photos-d1-1', 'coating', { id: 'c' }),
          det('photos-d1-2', 'leak', { id: 'r', status: 'rejected' }),
        ]),
      },
      {
        name: 'second.json',
        file: pass('photos-d2', [
          det('photos-d2-0', 'corrosion', { id: 'x', component: 'T-101' }),
          det('photos-d2-0', 'corrosion', { id: 'y', component: 'T-101' }),
          det('photos-d2-0', 'corrosion', { id: 'z', component: 'T-101' }),
          det('photos-d2-1', 'leak', { id: 'l', component: 'P-7' }),
          det('photos-d2-2', 'leak', { id: 'd', component: 'P-7', status: 'draft' }),
        ]),
      },
    ],
  });

  it('counts accepted detections per date and gives a verdict', () => {
    expect(items.map((i) => [i.id, i.verdict, i.count])).toEqual([
      ['detection:coating:site', 'resolved', { from: 1, to: 0 }],
      ['detection:corrosion:T-101', 'grown', { from: 2, to: 3 }],
      ['detection:leak:P-7', 'new', { from: 0, to: 1 }],
    ]);
    expect(items[1]).toMatchObject({
      fromIds: ['first.json#a', 'first.json#b'],
      toIds: ['second.json#x', 'second.json#y', 'second.json#z'],
      method: 'zone',
    });
  });

  it('says not seen when no pass of the later date looked', () => {
    const r = detectionChanges({
      manifest: SITE,
      index,
      from: 'd1',
      to: 'd2',
      passes: [{ name: 'first.json', file: pass('photos-d1', [det('photos-d1-0', 'coating')]) }],
    });
    expect(r.map((i) => i.verdict)).toEqual(['not-seen']);
  });

  it('joins detections of posed photos by the place on the ground they show', async () => {
    const passes = [
      {
        name: 'first.json',
        file: pass('photos-d1', [
          det('photos-d1-0', 'marker', { id: 'a', bbox: [490, 490, 510, 510] }),
          det('photos-d1-1', 'marker', { id: 'b', bbox: [495, 495, 505, 505] }),
          det('photos-d1-1', 'marker', { id: 'c', component: 'T-101' }),
        ]),
      },
      {
        name: 'second.json',
        file: pass('photos-d2', [
          det('photos-d2-0', 'marker', { id: 'x', bbox: [500, 500, 520, 520] }),
          det('photos-d2-2', 'marker', { id: 'y', bbox: [490, 490, 510, 510] }),
          det('photos-d2-1', 'marker', { id: 'z', component: 'T-101' }),
        ]),
      },
    ];
    const sizes: string[] = [];
    const locate = await photoDetectionLocator(SITE, passes, (layer, photo) => {
      sizes.push(`${layer}/${photo.id}`);
      return Promise.resolve([1000, 1000] as const);
    });
    const items = detectionChanges({ manifest: SITE, index, from: 'd1', to: 'd2', passes, locate });
    expect(items.map((i) => [i.zone, i.verdict, i.method, i.at])).toEqual([
      ['place at x 0 m, z 0 m', 'unchanged', 'place', [0.42, 0, 0.28]],
      ['place at x 20 m, z 0 m', 'resolved', 'place', [20, 0, 0]],
      ['place at x 40 m, z 0 m', 'new', 'place', [40, 0, 0]],
      ['T-101', 'unchanged', 'zone', undefined],
    ]);
    // each photo's size is read once
    expect(sizes.sort()).toEqual([
      'photos-d1/photos-d1-0',
      'photos-d1/photos-d1-1',
      'photos-d2/photos-d2-0',
      'photos-d2/photos-d2-1',
      'photos-d2/photos-d2-2',
    ]);
  });
});
