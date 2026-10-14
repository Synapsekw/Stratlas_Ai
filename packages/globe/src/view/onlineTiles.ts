/**
 * Online sources on the Globe (ADR 0007, amendments of 10 and 14 Oct 2026): Sentinel-2, Esri World
 * Imagery or a Mapbox map as a CesiumJS imagery provider, drawn in the Satellite look above the
 * street globe and under the imagery packs when the layer plan lists it (`planGlobeLayers`).
 *
 * The provider asks the app's own protocol only (`aio://online/<id>/{z}/{x}/{y}`): main decides
 * whether a tile is served (the switch, the key, the offline-only gate, the cache), so nothing
 * here names a server and the offline rules of `offline.ts` stand. No ion, Bing, Google, Esri or
 * Mapbox provider of CesiumJS is involved; this is a plain tile provider of our own, like
 * `PmtilesImageryProvider`.
 */
import { Event } from '@cesium/core';
import { Credit, WebMercatorTilingScheme, type ImageryProvider } from '@cesium/engine';
import { onlineSource, onlineTileUrl, type OnlineSourceId } from '@aio/schema';

/** Decode the tile bytes to an image CesiumJS uploads as it does its own (blob URL, no network). */
async function decodeImage(data: ArrayBuffer, type: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([data], { type: type || 'image/jpeg' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How the provider reads a tile: `fetch` on the app's own address by default. */
export type OnlineTileRead = (url: string) => Promise<Response>;

/**
 * One online source through `aio://online/<id>/...`. Tiles deeper than the source's own zoom are
 * drawn from the deepest ones by CesiumJS. A tile main does not serve (switched off, no key,
 * offline-only, the service unreachable) is a quiet failure: CesiumJS keeps the coarser tile it
 * has, and nothing is written to the console.
 */
export class OnlineTileImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel: number;
  readonly maximumLevel: number;
  readonly rectangle = this.tilingScheme.rectangle;
  readonly errorEvent = new Event();
  /** The credit the source's terms ask for, shown while the layer is. */
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = false;
  readonly tileDiscardPolicy = undefined;
  /** Tiles decoded so far (for the inspection hook and tests). */
  tilesLoaded = 0;
  private readonly label: string;

  constructor(
    readonly sourceId: OnlineSourceId,
    private readonly read: OnlineTileRead = (url) => fetch(url),
  ) {
    const source = onlineSource(sourceId);
    if (!source) throw new Error(`Unknown online source "${sourceId}"`);
    this.tileWidth = source.tileSize;
    this.tileHeight = source.tileSize;
    this.minimumLevel = source.minZoom;
    this.maximumLevel = source.maxZoom;
    this.credit = new Credit(source.attribution);
    this.label = source.label;
    // with a listener CesiumJS reports a missing tile here instead of logging it
    this.errorEvent.addEventListener(() => undefined);
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLImageElement> {
    const res = await this.read(onlineTileUrl(this.sourceId, level, x, y));
    if (!res.ok)
      throw new Error(
        `No ${this.label} tile ${String(level)}/${String(x)}/${String(y)} (${String(res.status)})`,
      );
    const img = await decodeImage(await res.arrayBuffer(), res.headers.get('content-type') ?? '');
    this.tilesLoaded++;
    return img;
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export function createOnlineTileProvider(
  sourceId: OnlineSourceId,
  read?: OnlineTileRead,
): ImageryProvider {
  return new OnlineTileImageryProvider(sourceId, read) as unknown as ImageryProvider;
}
