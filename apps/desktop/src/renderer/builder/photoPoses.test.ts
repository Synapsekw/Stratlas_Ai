import type * as Engine from '@aio/engine';
import type { AdapterContext, LayerHandle } from '@aio/engine';
import { emptyOrientation, type Layer } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';

const seen: Layer[] = [];
const handle: LayerHandle = { setVisible: () => undefined, dispose: () => undefined };
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  createPhotosAdapter: () => ({
    kind: 'photos',
    create: (layer: Layer) => {
      seen.push(layer);
      return Promise.resolve(handle);
    },
  }),
}));

const { createCorrectedPhotosAdapter } = await import('./photoPoses');

const layer = {
  kind: 'photos',
  id: 'ph',
  name: 'P',
  visible: true,
  items: [
    { id: 'a', src: { path: 'a.jpg' }, pos: [10, 5, 20] },
    { id: 'b', src: { path: 'b.jpg' } },
  ],
} as unknown as Extract<Layer, { kind: 'photos' }>;

describe('createCorrectedPhotosAdapter', () => {
  it('shifts a corrected photo after its correction', async () => {
    const ws = createWorkspace();
    ws.getState().setOrientation({
      ...emptyOrientation(),
      photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [1, 0, 0] } } },
    });
    const ctx = { shiftOf: () => ({ eastM: 2, northM: 3 }) } as unknown as AdapterContext;
    await createCorrectedPhotosAdapter(ws).create(layer, ctx);
    const items = (seen.at(-1) as typeof layer).items;
    // the hand-set offset first (x 11), then the line-up (east 2, north 3: z 20 - 3)
    expect(items[0]?.pos).toEqual([13, 5, 17]);
    expect(items[1]?.pos).toBeUndefined();
  });

  it('draws a pinned photo at its pin, not moved by a hand correction', async () => {
    const ws = createWorkspace();
    ws.getState().setOrientation({
      ...emptyOrientation(),
      photos: { ph: { p: { yawDeg: 40, pitchDeg: 0, rollDeg: 0, offsetM: [1, 0, 0] } } },
    });
    const pinned = {
      ...layer,
      items: [
        {
          id: 'p',
          src: { path: 'p.jpg' },
          pos: [1, 1.6, 3],
          q: [0, 0, 0, 1],
          pin: { ground: [1, 0, 3], eyeM: 1.6 },
        },
      ],
    } as unknown as typeof layer;
    await createCorrectedPhotosAdapter(ws).create(pinned, {} as unknown as AdapterContext);
    const item = (seen.at(-1) as typeof layer).items[0];
    expect(item?.pos).toEqual([1, 1.6, 3]);
    expect(item?.q).toEqual([0, 0, 0, 1]);
  });

  it('leaves photos alone on a date that does not move', async () => {
    const ws = createWorkspace();
    await createCorrectedPhotosAdapter(ws).create(layer, {} as unknown as AdapterContext);
    expect((seen.at(-1) as typeof layer).items[0]?.pos).toEqual([10, 5, 20]);
  });
});
