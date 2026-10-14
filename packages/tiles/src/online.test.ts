import { describe, expect, it } from 'vitest';
import { createOnlineTileSource } from './online';
import { zoomFor } from './surroundings';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function reader(status = 200, body: Uint8Array = png) {
  const asked: string[] = [];
  const read = (url: string) => {
    asked.push(url);
    return Promise.resolve(new Response(status === 200 ? (body as BodyInit) : null, { status }));
  };
  return { asked, read };
}

describe('an online source around the site in 3D', () => {
  it("asks the app's own address and answers the bytes", async () => {
    const { asked, read } = reader();
    const src = createOnlineTileSource('esri-world-imagery', read);
    const t = await src.getTile(15, 21000, 13000);
    expect(asked).toEqual(['aio://online/esri-world-imagery/15/21000/13000']);
    expect(new Uint8Array(t?.data ?? new ArrayBuffer(0))).toEqual(png);
    expect(t?.pack.id).toBe('esri-world-imagery');
  });

  it('is imagery of the whole Earth with the source zoom range and credit', () => {
    const src = createOnlineTileSource('mapbox-satellite', reader().read);
    expect(src.kind).toBe('imagery');
    expect(src.packs).toHaveLength(1);
    expect(src.packs[0]?.bbox).toEqual([-180, -85.0511, 180, 85.0511]);
    expect([src.minZoom, src.maxZoom]).toEqual([0, 19]);
    expect(src.tilePx).toBe(512);
    expect(src.credits()).toEqual(['© Mapbox © Maxar']);
  });

  it('answers nothing for a tile main does not serve, or an empty one', async () => {
    expect(
      await createOnlineTileSource('mapbox-dark', reader(401).read).getTile(3, 1, 1),
    ).toBeUndefined();
    expect(
      await createOnlineTileSource('mapbox-dark', reader(200, new Uint8Array(0)).read).getTile(
        3,
        1,
        1,
      ),
    ).toBeUndefined();
  });

  it('chooses a shallower zoom for denser tiles, so the texture stays inside its budget', () => {
    const s2 = createOnlineTileSource('esri-world-imagery', reader().read);
    const mapbox = createOnlineTileSource('mapbox-streets', reader().read);
    const span = 0.06;
    // 1024 px tiles are four times as wide as 256 px ones: two zoom levels shallower
    expect(zoomFor(span, 2048, s2) - zoomFor(span, 2048, mapbox)).toBe(2);
  });
});
