import type { LayerBlobStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { needsAttention, newJobId, rowView } from './filesModel';

const layer = (o: Partial<LayerBlobStatus>): LayerBlobStatus => ({
  layer: 'l',
  state: 'missing',
  policy: 'on-demand',
  files: 1,
  bytes: 1000,
  have: 0,
  ...o,
});

describe('files panel rows', () => {
  it('offers Download for a missing layer and Cancel while it runs', () => {
    expect(rowView(layer({}))).toMatchObject({ text: 'blobs.notHere', action: 'download' });
    expect(rowView(layer({}), { state: 'running', done: 250, total: 1000 })).toEqual({
      text: 'blobs.downloading',
      bytes: 1000,
      done: 250,
      action: 'cancel',
      fraction: 0.25,
    });
  });

  it('offers Resume for a paused download and nothing for a present layer', () => {
    expect(rowView(layer({ state: 'partial', have: 500 }))).toMatchObject({
      text: 'blobs.partial',
      action: 'resume',
      fraction: 0.5,
    });
    expect(rowView(layer({ state: 'present', have: 1000 }))).toMatchObject({ action: null });
    expect(rowView(layer({ state: 'streaming' })).text).toBe('blobs.streaming');
    expect(rowView(layer({ state: 'stale' })).action).toBe('download');
    // a finished or cancelled job falls back to the status
    expect(rowView(layer({}), { state: 'cancelled', done: 1, total: 2 }).action).toBe('download');
  });

  it('lists only layers that can be fetched', () => {
    const list = [
      layer({ layer: 'a' }),
      layer({ layer: 'b', state: 'present' }),
      layer({ layer: 'c', bytes: 0 }),
      layer({ layer: 'd', state: 'streaming' }),
    ];
    expect(needsAttention(list).map((l) => l.layer)).toEqual(['a', 'd']);
    expect(newJobId()).toMatch(/^dl-[a-z0-9]+-[a-z0-9]+$/);
    expect(newJobId().length).toBeLessThanOrEqual(64);
  });
});
