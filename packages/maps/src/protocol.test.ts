import { describe, expect, it } from 'vitest';
import type { MapPack } from './packs';
import { createMapProtocol, type TileReader } from './protocol';

const world: MapPack = {
  id: 'world',
  label: 'W',
  bbox: [-180, -85, 180, 85],
  maxZoom: 6,
  sizeBytes: 1,
};
const gcc: MapPack = {
  id: 'gcc',
  label: 'G',
  bbox: [34.5, 12, 60, 32.5],
  maxZoom: 15,
  sizeBytes: 1,
};

function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}
function text(b: unknown): string {
  return new TextDecoder().decode(b as ArrayBuffer);
}

function fakeReader(id: string, has: (z: number) => boolean): TileReader {
  return {
    getZxy: (z, x, y) =>
      Promise.resolve(has(z) ? { data: bytes(`${id}/${z}/${x}/${y}`) } : undefined),
  };
}

describe('aiomap protocol', () => {
  const opened: string[] = [];
  const handler = createMapProtocol({
    packs: [world, gcc],
    openPack: (p) => {
      opened.push(p.id);
      return fakeReader(p.id, (z) => z <= p.maxZoom);
    },
    assets: {
      'fonts/Noto Sans Regular/0-255.pbf': () => Promise.resolve(bytes('glyphs')),
      'sprites/dark.json': () => Promise.resolve(bytes('{"poi":{"x":0}}')),
      'sprites/dark.png': () => Promise.resolve(bytes('png')),
    },
  });
  const ac = new AbortController();

  it('serves low zoom tiles from the world pack', async () => {
    const r = await handler({ url: 'aiomap://tiles/4/10/6', type: 'arrayBuffer' }, ac);
    expect(text(r.data)).toBe('world/4/10/6');
  });

  it('serves street tiles from the regional pack', async () => {
    const r = await handler({ url: 'aiomap://tiles/14/10394/6826', type: 'arrayBuffer' }, ac);
    expect(text(r.data)).toBe('gcc/14/10394/6826');
  });

  it('returns an empty tile where no pack reaches', async () => {
    const r = await handler({ url: 'aiomap://tiles/10/518/352', type: 'arrayBuffer' }, ac);
    expect((r.data as ArrayBuffer).byteLength).toBe(0);
  });

  it('opens each pack once', () => {
    expect(opened.sort()).toEqual(['gcc', 'world']);
  });

  it('serves bundled glyphs and an empty range for unbundled ones', async () => {
    const g = await handler({ url: 'aiomap://glyphs/Noto%20Sans%20Regular/0-255.pbf' }, ac);
    expect(text(g.data)).toBe('glyphs');
    const none = await handler({ url: 'aiomap://glyphs/Noto%20Sans%20Thai/3584-3839.pbf' }, ac);
    expect((none.data as ArrayBuffer).byteLength).toBe(0);
  });

  it('serves sprite json parsed and sprite images as bytes', async () => {
    const j = await handler({ url: 'aiomap://sprites/dark.json', type: 'json' }, ac);
    expect(j.data).toEqual({ poi: { x: 0 } });
    const i = await handler({ url: 'aiomap://sprites/dark.png', type: 'image' }, ac);
    expect(text(i.data)).toBe('png');
  });

  it('rejects unknown resources', async () => {
    await expect(handler({ url: 'aiomap://elsewhere/x' }, ac)).rejects.toThrow(
      'Unknown map resource',
    );
    await expect(handler({ url: 'aiomap://sprites/white.json', type: 'json' }, ac)).rejects.toThrow(
      'not bundled',
    );
  });

  it('falls back to the dark sprite sheet when the light one is not bundled', async () => {
    const j = await handler({ url: 'aiomap://sprites/light.json', type: 'json' }, ac);
    expect(j.data).toEqual({ poi: { x: 0 } });
    const i = await handler({ url: 'aiomap://sprites/light.png', type: 'image' }, ac);
    expect(text(i.data)).toBe('png');
  });
});
