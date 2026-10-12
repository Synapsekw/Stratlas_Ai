import type { Capture, Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { captureIndex } from './captures';
import { planFiling, recordingDay } from './surveyDays';

const photos = (id: string, days: (string | undefined)[], extra: object = {}): Layer =>
  ({
    kind: 'photos',
    id,
    name: id,
    visible: true,
    items: days.map((d, i) => ({
      id: `${id}-${i}`,
      src: { path: `assets/${id}-${i}.jpg` },
      ...(d ? { takenAt: `${d}T10:00:00` } : {}),
    })),
    ...extra,
  }) as unknown as Layer;

const video = (id: string, startUtcMs: number, extra: object = {}): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    src: { path: `assets/${id}.mp4` },
    flight: { src: { path: `assets/${id}.json` }, startUtcMs },
    ...extra,
  }) as unknown as Layer;

const mesh = (id: string): Layer =>
  ({
    kind: 'mesh',
    id,
    name: id,
    visible: true,
    src: { path: `assets/${id}.glb` },
  }) as unknown as Layer;

const cap = (date: string): Capture => ({ id: `capture-${date}`, label: 'Survey', date });

describe('recordingDay', () => {
  it('takes the day most photos were taken on', () => {
    expect(recordingDay(photos('p', ['2024-11-06', '2024-11-07', '2024-11-07']), 0)).toBe(
      '2024-11-07',
    );
  });
  it('takes the earlier day on a tie', () => {
    expect(recordingDay(photos('p', ['2024-11-07', '2024-11-06']), 0)).toBe('2024-11-06');
  });
  it('is null for photos without dates', () => {
    expect(recordingDay(photos('p', [undefined, undefined]), 0)).toBeNull();
  });
  it('puts a video flight on its local day across midnight', () => {
    const start = Date.UTC(2024, 10, 6, 22, 0, 0);
    expect(recordingDay(video('v', start), 0)).toBe('2024-11-06');
    expect(recordingDay(video('v', start), 180)).toBe('2024-11-07');
  });
  it('is null for other kinds', () => {
    expect(recordingDay(mesh('m'), 0)).toBeNull();
  });
});

describe('planFiling', () => {
  it('groups undated layers by day, oldest first, with the existing date or null', () => {
    const layers = [
      photos('a', ['2024-11-07']),
      video('b', Date.UTC(2024, 10, 6, 9, 0, 0)),
      photos('c', ['2024-11-07']),
    ];
    const manifest = { captures: [cap('2024-11-07')], layers };
    expect(planFiling(manifest, captureIndex(manifest), 0)).toEqual({
      groups: [
        { day: '2024-11-06', captureId: null, layerIds: ['b'] },
        { day: '2024-11-07', captureId: 'capture-2024-11-07', layerIds: ['a', 'c'] },
      ],
      mixed: [],
    });
  });
  it('leaves out name-dated layers, meshes and layers with a capture', () => {
    const layers = [
      photos('Ortho 2024-11-06', ['2024-11-06']),
      mesh('m'),
      video('v', Date.UTC(2024, 10, 6, 9, 0, 0), { capture: 'capture-2024-11-05' }),
    ];
    const manifest = { captures: [cap('2024-11-05'), cap('2024-11-06')], layers };
    expect(planFiling(manifest, captureIndex(manifest), 0)).toEqual({ groups: [], mixed: [] });
  });
  it('leaves out a photos layer holding several days and names it in mixed', () => {
    const layers = [
      photos('two', ['2024-11-06', '2024-11-06', '2024-11-07', undefined]),
      photos('one', ['2024-11-06', undefined]),
    ];
    const manifest = { captures: [], layers };
    expect(planFiling(manifest, captureIndex(manifest), 0)).toEqual({
      groups: [{ day: '2024-11-06', captureId: null, layerIds: ['one'] }],
      mixed: ['two'],
    });
  });
  it('does not count a several-day layer that already has a date', () => {
    const layers = [photos('two', ['2024-11-06', '2024-11-07'], { capture: 'capture-2024-11-05' })];
    const manifest = { captures: [cap('2024-11-05')], layers };
    expect(planFiling(manifest, captureIndex(manifest), 0)).toEqual({ groups: [], mixed: [] });
  });
});
