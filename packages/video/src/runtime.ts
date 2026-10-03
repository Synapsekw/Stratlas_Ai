import type { AssetRef, Layer } from '@aio/schema';
import { assetUrl, workspace, type createWorkspace } from '@aio/workspace';
import { parseFlight, type Flight } from './flight';

export type WorkspaceStore = ReturnType<typeof createWorkspace>;

export type VideoLayer = Extract<Layer, { kind: 'video' }>;

interface VideoRuntimeConfig {
  store: WorkspaceStore;
  /** Asset reference to a fetchable URL. Defaults to aio://project/<id>/... */
  resolveUrl: (projectId: string, ref: AssetRef) => string;
}

const config: VideoRuntimeConfig = { store: workspace, resolveUrl: assetUrl };

/**
 * Overrides the workspace store or the URL resolver (tests, verification harnesses). The app uses
 * the defaults.
 */
export function configureVideo(c: Partial<VideoRuntimeConfig>): void {
  Object.assign(config, c);
}

export function videoStore(): WorkspaceStore {
  return config.store;
}

export function resolveAsset(ref: AssetRef): string {
  const project = config.store.getState().project;
  if (!project) throw new Error('No project is open');
  return config.resolveUrl(project.id, ref);
}

export function findVideoLayer(layerId: string): VideoLayer | null {
  const layer = config.store.getState().project?.manifest.layers.find((l) => l.id === layerId);
  return layer?.kind === 'video' ? layer : null;
}

const flights = new Map<string, Promise<Flight>>();

/** Loads and parses a pose file once per URL. */
export function loadFlight(url: string): Promise<Flight> {
  let p = flights.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Flight file ${url} returned ${r.status}`);
        return r.text();
      })
      .then(parseFlight);
    p.catch(() => flights.delete(url));
    flights.set(url, p);
  }
  return p;
}

export function loadLayerFlight(layer: VideoLayer): Promise<Flight> {
  return loadFlight(resolveAsset(layer.flight.src));
}
