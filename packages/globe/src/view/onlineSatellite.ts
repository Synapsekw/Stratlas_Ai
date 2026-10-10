/**
 * Online satellite on the Globe (ADR 0007, amendment of 10 Oct 2026): Sentinel-2 cloudless 2016 as
 * a CesiumJS imagery provider. The Globe draws it in the Satellite look, above the street globe and
 * under the imagery packs, when the layer plan lists it (`planGlobeLayers`, `onlineSatellite`).
 *
 * The provider asks the app's own protocol only (`aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg`,
 * `ONLINE_SATELLITE.tileUrl`): main decides whether a tile is served (the person's switch, the
 * offline-only gate, the cache), so nothing here names a server and the offline rules of
 * `offline.ts` stand. No ion, Bing, Google, Esri or Mapbox provider is involved; this is a plain
 * tile provider of our own, like `PmtilesImageryProvider`.
 *
 * The host says when it may be drawn: while `onlineSatelliteAvailability({ satellite,
 * offlineOnly })` is not `off` (`satellite` from `onlineTiles:status`). Its credit shows in the
 * Globe's credits while it is drawn (`planCredits`).
 */
import { Event } from '@cesium/core';
import { Credit, WebMercatorTilingScheme, type ImageryProvider } from '@cesium/engine';
import { ONLINE_SATELLITE, onlineSatelliteTileUrl } from '@aio/schema';

/** Decode JPEG bytes to an image CesiumJS uploads as it does its own (blob URL, no network). */
async function decodeJpeg(data: ArrayBuffer): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
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
 * Sentinel-2 cloudless 2016 through `aio://online/...`. Tiles deeper than the imagery's own zoom
 * (14) are drawn from the deepest ones by CesiumJS. A tile main does not serve (switched off,
 * offline-only and not cached, the service unreachable) is a quiet failure: CesiumJS keeps the
 * coarser tile it has, and nothing is written to the console.
 */
export class OnlineSatelliteImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly tileWidth = ONLINE_SATELLITE.tileSize;
  readonly tileHeight = ONLINE_SATELLITE.tileSize;
  readonly minimumLevel = ONLINE_SATELLITE.minZoom;
  readonly maximumLevel = ONLINE_SATELLITE.maxZoom;
  readonly rectangle = this.tilingScheme.rectangle;
  readonly errorEvent = new Event();
  /** The credit the licence asks for (CC BY 4.0), shown while the layer is. */
  readonly credit = new Credit(ONLINE_SATELLITE.attribution);
  readonly proxy = undefined;
  readonly hasAlphaChannel = false;
  readonly tileDiscardPolicy = undefined;
  /** Tiles decoded so far (for the inspection hook and tests). */
  tilesLoaded = 0;

  constructor(private readonly read: OnlineTileRead = (url) => fetch(url)) {
    // with a listener CesiumJS reports a missing tile here instead of logging it
    this.errorEvent.addEventListener(() => undefined);
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  async requestImage(x: number, y: number, level: number): Promise<HTMLImageElement> {
    const res = await this.read(onlineSatelliteTileUrl(level, x, y));
    if (!res.ok)
      throw new Error(
        `No online satellite tile ${String(level)}/${String(x)}/${String(y)} (${String(res.status)})`,
      );
    const img = await decodeJpeg(await res.arrayBuffer());
    this.tilesLoaded++;
    return img;
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export function createOnlineSatelliteProvider(read?: OnlineTileRead): ImageryProvider {
  return new OnlineSatelliteImageryProvider(read) as unknown as ImageryProvider;
}
