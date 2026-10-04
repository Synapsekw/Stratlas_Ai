import { getAdapter, registerAdapter, type LayerAdapter, type SceneHandle } from '@aio/engine';
import type { StoreApi } from 'zustand/vanilla';
import { CloudManager, type ChunkState } from './manager';
import { pickPoint } from './pick';
import { parsePngCloudIndex, type PngCloudIndex } from './pngIndex';
import { createWorkerPool, type Decoder } from './pool';
import { pointcloudSettings, type PointcloudSettings } from './settings';

type ChunkSeed = Omit<ChunkState, 'object' | 'busy' | 'failed'>;

export interface PointcloudAdapterOptions {
  /** Creates the decoder for a scene; default: a pool of module workers. */
  decoder?: () => Decoder;
  settings?: StoreApi<PointcloudSettings>;
  fetchJson?: (url: string) => Promise<unknown>;
}

/** Base point size for kit (LiDAR, voxel-thinned to about 2 cm) clouds, metres. */
export const KIT_BASE_SIZE = 0.025;

const managers = new WeakMap<SceneHandle, CloudManager>();
const pickers = new WeakMap<SceneHandle, () => void>();

/** The cloud manager of a scene, if it shows any cloud. Used by picking. */
export function getCloudManager(handle: SceneHandle): CloudManager | undefined {
  return managers.get(handle);
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load the point cloud index ${url} (${r.status})`);
  return r.json();
}

/** Typical spacing: the index's own value, else sqrt(ground area / points). */
export function pngBaseSize(idx: PngCloudIndex): number {
  if (idx.spacing) return idx.spacing;
  const dx = idx.bounds.max[0] - idx.bounds.min[0];
  const dz = idx.bounds.max[2] - idx.bounds.min[2];
  const s = Math.sqrt((Math.max(dx, 1) * Math.max(dz, 1)) / Math.max(idx.totalPoints, 1));
  return Math.min(2, Math.max(0.005, s));
}

function resolveChunkUrl(
  file: string,
  idx: PngCloudIndex,
  indexUrl: string,
  pkg: (p: string) => string,
) {
  if (!idx.legacy) return pkg(file);
  try {
    return new URL(file, indexUrl).href;
  } catch {
    return file;
  }
}

export function createPointcloudAdapter(
  opts: PointcloudAdapterOptions = {},
): LayerAdapter<'pointcloud'> {
  const makeDecoder = opts.decoder ?? (() => createWorkerPool());
  const settings = opts.settings ?? pointcloudSettings;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;

  return {
    kind: 'pointcloud',
    async create(layer, ctx) {
      let chunks: ChunkSeed[];
      let baseSize: number;
      const url = ctx.url(layer.src);
      if (layer.format === 'kit-packed') {
        chunks = [
          {
            key: `${layer.id}#0`,
            source: { kind: 'kit', url, scale: 0.001 },
            points: layer.pointCount ?? 0,
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
            lod: 0,
          },
        ];
        baseSize = KIT_BASE_SIZE;
      } else if (layer.format === 'png-packed') {
        const idx = parsePngCloudIndex(await fetchJson(url));
        chunks = idx.chunks.map((c) => ({
          key: `${layer.id}#${c.id}`,
          source: {
            kind: 'png',
            url: resolveChunkUrl(c.file, idx, url, (path) => ctx.url({ path })),
            quant: c.quant,
          },
          points: c.points,
          bounds: c.bounds,
          lod: c.lod,
        }));
        baseSize = pngBaseSize(idx);
      } else {
        throw new Error(`Point cloud format "${layer.format}" is not supported yet`);
      }

      const handle = ctx.scene;
      let manager = managers.get(handle);
      if (!manager) {
        manager = new CloudManager(handle, makeDecoder, settings);
        managers.set(handle, manager);
        // clouds take part in SceneHandle.raycast (cursor readout, annotation, measure)
        pickers.set(
          handle,
          handle.addRaycastProvider((x, y) => pickPoint(handle, { x, y })),
        );
      }
      const m = manager;
      m.addLayer(layer.id, chunks, baseSize, layer.format === 'png-packed');
      if (!layer.visible) m.setVisible(layer.id, false);
      return {
        setVisible: (v) => {
          m.setVisible(layer.id, v);
        },
        dispose: () => {
          m.removeLayer(layer.id);
          if (m.empty) {
            m.dispose();
            managers.delete(handle);
            pickers.get(handle)?.();
            pickers.delete(handle);
          }
        },
      };
    },
  };
}

/** Registers the point-cloud layer adapter with @aio/engine. Safe to call more than once. */
export function registerPointcloudAdapters(): void {
  if (getAdapter('pointcloud')) return;
  registerAdapter(createPointcloudAdapter() as unknown as LayerAdapter);
}
