import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { frameLayerSrc, splitWrapKey, wrapKey, wrapParts } from './frameMedia';

describe('the video a frame detection is on', () => {
  const layers = [
    { kind: 'video', id: 'v', src: { path: 'video/v.mp4' } },
    { kind: 'walk', id: 'w', src: { path: 'walks/w/playback.mp4' } },
    { kind: 'mesh', id: 'm' },
  ] as unknown as Layer[];

  it('is the clip of a video layer and the playback copy of a walk', () => {
    expect(frameLayerSrc(layers, 'v')).toEqual({ path: 'video/v.mp4' });
    expect(frameLayerSrc(layers, 'w')).toEqual({ path: 'walks/w/playback.mp4' });
  });

  it('is nothing for other layers or a missing one', () => {
    expect(frameLayerSrc(layers, 'm')).toBeNull();
    expect(frameLayerSrc(layers, 'gone')).toBeNull();
  });
});

describe('a box across the 360 seam', () => {
  it('stays whole when it fits the frame', () => {
    const g = { type: 'box', x: 10, y: 5, w: 20, h: 8 } as const;
    expect(wrapParts(g, 100)).toEqual([g]);
  });

  it('is drawn as its part up to the right edge and the rest from x = 0', () => {
    const g = { type: 'box', x: 90, y: 5, w: 25, h: 8 } as const;
    expect(wrapParts(g, 100)).toEqual([
      { type: 'box', x: 90, y: 5, w: 10, h: 8 },
      { type: 'box', x: 0, y: 5, w: 15, h: 8 },
    ]);
  });

  it('leaves other shapes as they are', () => {
    const g = { type: 'point', x: 120, y: 5 } as const;
    expect(wrapParts(g, 100)).toEqual([g]);
  });

  it('keys the second part so a click on it selects the detection', () => {
    expect(splitWrapKey('d1')).toBe('d1');
    expect(splitWrapKey(wrapKey('d1'))).toBe('d1');
  });
});
