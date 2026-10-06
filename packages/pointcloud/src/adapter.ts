import { getAdapter, registerAdapter, type LayerAdapter, type SceneHandle } from '@aio/engine';
import type { PointcloudScalar } from '@aio/schema';
import { workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { withScalar } from './copc';
import { copcChunkSeeds } from './copcLayer';
import { CloudManager, type ChunkSeed, type CopcLayerInfo } from './manager';
import { pickPoint } from './pick';
import { parsePngCloudIndex, type PngCloudIndex } from './pngIndex';
import { createWorkerPool, type Decoder } from './pool';
import { pointcloudSettings, type PointcloudSettings } from './settings';
import { pointcloudStats } from './stats';

type V3 = readonly [number, number, number];

export interface PointcloudAdapterOptions {
  /** Creates the decoder for a scene; default: a pool of module workers. */
  decoder?: () => Decoder;
  settings?: StoreApi<PointcloudSettings>;
  fetchJson?: (url: string) => Promise<unknown>;
  /**
   * The project origin [E, N, H] that COPC coordinates are relative to; default: the open
   * project's manifest `origin`.
   */
  origin?: () => V3 | null;
}

/** A Distance field the layer does not describe: unsigned metres, full colour at 30 cm. */
const DEFAULT_SCALAR: PointcloudScalar = {
  dim: 'Distance',
  label: 'Distance',
  unit: 'm',
  range: [0, 0.3],
  diverging: false,
};

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

function projectOrigin(): V3 | null {
  return workspace.getState().project?.manifest.origin ?? null;
}

function projectEpsg(): number | null {
  const crs = workspace.getState().project?.manifest.crs;
  return crs && 'epsg' in crs ? crs.epsg : null;
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
  const originOf = opts.origin ?? projectOrigin;

  const managerFor = (handle: SceneHandle): CloudManager => {
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
    return manager;
  };
  const release = (handle: SceneHandle, m: CloudManager) => {
    if (!m.empty) return;
    m.dispose();
    managers.delete(handle);
    pickers.get(handle)?.();
    pickers.delete(handle);
  };

  return {
    kind: 'pointcloud',
    async create(layer, ctx) {
      let chunks: ChunkSeed[];
      let baseSize: number;
      let copc: CopcLayerInfo | null = null;
      let scalar: PointcloudScalar | null = null;
      const url = ctx.url(layer.src);
      const handle = ctx.scene;
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
      } else if (layer.format === 'copc') {
        const origin = originOf();
        if (!origin) throw new Error('A COPC layer needs the project origin');
        const m = managerFor(handle);
        try {
          const dec = m.getDecoder();
          if (!dec.copcSource || !dec.copcPage) throw new Error('This decoder cannot read COPC');
          // the change field (cloud change): the layer names it, else a Distance dimension
          const dim = layer.scalar?.dim ?? 'Distance';
          const sc = withScalar(await dec.copcSource(url), dim);
          if (sc.error) {
            const msg = `${layer.name}: ${sc.error}`;
            console.warn(msg);
            pointcloudStats.getState().addError(msg);
          }
          const source = sc.source;
          if (source.layout.scalar) scalar = layer.scalar ?? { ...DEFAULT_SCALAR, dim };
          const epsg = projectEpsg();
          if (source.epsg !== undefined && epsg !== null && source.epsg !== epsg) {
            const msg = `${layer.name}: the cloud is in EPSG ${source.epsg}, the project in EPSG ${epsg}`;
            console.warn(msg);
            pointcloudStats.getState().addError(msg);
          }
          const root = await dec.copcPage(url, source.rootPage);
          chunks = copcChunkSeeds(layer.id, url, source, root, origin);
          baseSize = source.spacing;
          copc = { url, source, origin };
        } catch (e) {
          release(handle, m);
          throw e;
        }
      } else {
        throw new Error(`Point cloud format "${layer.format}" is not supported yet`);
      }

      const m = managerFor(handle);
      // png-packed clouds carry colour; COPC does in point formats 7 and 8
      const rgbHint =
        layer.format === 'png-packed' ||
        (copc !== null && copc.source.layout.pointDataRecordFormat !== 6);
      m.addLayer(layer.id, chunks, baseSize, rgbHint, copc, scalar);
      if (!layer.visible) m.setVisible(layer.id, false);
      return {
        setVisible: (v) => {
          m.setVisible(layer.id, v);
        },
        dispose: () => {
          m.removeLayer(layer.id);
          release(handle, m);
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
