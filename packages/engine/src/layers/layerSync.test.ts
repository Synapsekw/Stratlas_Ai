import type { Layer, LayerKind } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterContext, LayerAdapter, LayerHandle } from '../types';
import { LayerSync } from './layerSync';

const mesh = (id: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});
const video = (id: string): Layer => ({
  kind: 'video',
  id,
  name: id,
  visible: true,
  src: { path: 'v.mp4' },
  flight: { src: { path: 'f.json' }, startUtcMs: 0 },
  lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7 },
  offsetMs: 0,
});

interface Fake extends LayerHandle {
  visible: boolean | null;
  disposed: boolean;
}

function deferredAdapter(kind: LayerKind) {
  const pending: { layer: Layer; resolve: (h: Fake) => void; reject: (e: Error) => void }[] = [];
  const adapter: LayerAdapter = {
    kind,
    create: (layer) =>
      new Promise<LayerHandle>((resolve, reject) => {
        pending.push({ layer, resolve, reject });
      }),
  };
  const fake = (): Fake => {
    const f: Fake = {
      visible: null,
      disposed: false,
      setVisible(v) {
        f.visible = v;
      },
      dispose() {
        f.disposed = true;
      },
    };
    return f;
  };
  return { adapter, pending, fake };
}

const ctx = {} as AdapterContext;
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const m = deferredAdapter('mesh');
  const onError = vi.fn();
  const onMissing = vi.fn();
  const onLoaded = vi.fn();
  const sync = new LayerSync({
    getAdapter: (kind) => (kind === 'mesh' ? m.adapter : undefined),
    ctx,
    onError,
    onMissing,
    onLoaded,
  });
  return { m, sync, onError, onMissing, onLoaded };
}

describe('LayerSync', () => {
  it('creates a handle per layer through the adapter registered for its kind', async () => {
    const { m, sync, onMissing, onLoaded } = setup();
    sync.sync([mesh('a'), video('v'), mesh('b')], {});
    expect(m.pending.map((p) => p.layer.id)).toEqual(['a', 'b']);
    expect(onMissing).toHaveBeenCalledWith(expect.objectContaining({ id: 'v' }));
    const h = m.fake();
    m.pending[0]?.resolve(h);
    await flush();
    expect(h.visible).toBe(true);
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), h);
    expect(sync.handle('a')).toBe(h);
  });

  it('honours hidden layers before and after the handle arrives', async () => {
    const { m, sync } = setup();
    sync.sync([mesh('a')], { a: true });
    const h = m.fake();
    m.pending[0]?.resolve(h);
    await flush();
    expect(h.visible).toBe(false);
    sync.sync([mesh('a')], {});
    expect(h.visible).toBe(true);
    expect(m.pending).toHaveLength(1); // no re-create for a visibility change
  });

  it('disposes layers that leave the manifest', async () => {
    const { m, sync } = setup();
    const a = mesh('a');
    sync.sync([a, mesh('b')], {});
    const ha = m.fake();
    m.pending[0]?.resolve(ha);
    await flush();
    sync.sync([mesh('b')], {});
    expect(ha.disposed).toBe(true);
    expect(sync.handle('a')).toBeUndefined();
  });

  it('disposes a handle that resolves after its layer was removed', async () => {
    const { m, sync, onLoaded } = setup();
    sync.sync([mesh('a')], {});
    sync.sync([], {});
    const late = m.fake();
    m.pending[0]?.resolve(late);
    await flush();
    expect(late.disposed).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('re-creates a layer whose definition changed', async () => {
    const { m, sync } = setup();
    sync.sync([mesh('a')], {});
    const h1 = m.fake();
    m.pending[0]?.resolve(h1);
    await flush();
    const changed = { ...mesh('a'), src: { path: 'models/other.glb' } } as Layer;
    sync.sync([changed], {});
    expect(h1.disposed).toBe(true);
    expect(m.pending).toHaveLength(2);
  });

  it('reports adapter failures without throwing', async () => {
    const { m, sync, onError } = setup();
    sync.sync([mesh('a')], {});
    m.pending[0]?.reject(new Error('bad glb'));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.any(Error));
  });

  it('disposes everything on dispose()', async () => {
    const { m, sync } = setup();
    sync.sync([mesh('a'), mesh('b')], {});
    const ha = m.fake();
    m.pending[0]?.resolve(ha);
    await flush();
    sync.dispose();
    const hb = m.fake();
    m.pending[1]?.resolve(hb);
    await flush();
    expect(ha.disposed).toBe(true);
    expect(hb.disposed).toBe(true);
  });
});
