/// <reference types="vite/client" />
// Browser-only MapLibre wiring: worker URL, the aiomap:// protocol and bundled assets. Loaded lazily
// by MapView so importing @aio/maps never pulls MapLibre into tests or the main process.
import { addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { FetchSource, PMTiles } from 'pmtiles';
import type { MapPack } from './packs';
import { createMapProtocol, type AssetLoaders, type MapProtocolHandler } from './protocol';
import { MAP_PROTOCOL } from './style';

// Glyph ranges (git-ignored, fetched by tools/maps/build-packs.mjs) and sprites, emitted by Vite as
// app assets. A missing glyph file only drops those labels.
const assetUrls = import.meta.glob<string>('../assets/**/*.{pbf,json,png}', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** Reads a bundled asset; XHR fallback for app schemes the fetch API does not serve (file://). */
async function loadBytes(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.arrayBuffer();
  } catch {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.response instanceof ArrayBuffer) resolve(xhr.response);
        else reject(new Error(`Failed to load ${url}`));
      };
      xhr.onerror = () => {
        reject(new Error(`Failed to load ${url}`));
      };
      xhr.send();
    });
  }
}

const assets: AssetLoaders = Object.fromEntries(
  Object.entries(assetUrls).map(([path, url]) => [
    path.replace(/^\.\.\/assets\//, ''),
    () => loadBytes(url),
  ]),
);

let handler: MapProtocolHandler | null = null;
let installed = false;

export interface RuntimeOptions {
  /** Base URL of pack files; the app uses aio://packs/ (served by main with range requests). */
  packBase?: string;
}

/** Points the aiomap:// protocol at the given packs. Safe to call again when packs change. */
export function installBasemap(
  packs: readonly MapPack[],
  { packBase = 'aio://packs/' } = {},
): void {
  handler = createMapProtocol({
    packs,
    openPack: (p) => new PMTiles(new FetchSource(`${packBase}${p.id}.pmtiles`)),
    assets,
  });
  if (installed) return;
  installed = true;
  setWorkerUrl(workerUrl);
  addProtocol(MAP_PROTOCOL, (params, abort) => {
    if (!handler) return Promise.reject(new Error('No map packs installed'));
    return handler(params, abort);
  });
}
