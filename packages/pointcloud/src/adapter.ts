import {
  getAdapter,
  registerAdapter,
  type LayerAdapter,
  type LayerHandle,
  type SceneHandle,
} from '@aio/engine';
import { cloudFrameOrigin, type Layer, type PointcloudScalar } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Box3, Vector3 } from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { pointcloudCleanup, type CleanupRecipes } from './cleanup/store';
import { withScalar } from './copc';
import { copcChunkSeeds } from './copcLayer';
import { cloudRayProvider } from './cloudRay';
import { CloudManager, type ChunkSeed, type CopcLayerInfo } from './manager';
import { pickPoint } from './pick';
import { parsePngCloudIndex, type PngCloudIndex } from './pngIndex';
import { createWorkerPool, type Decoder } from './pool';
import { pointcloudSettings, type PointcloudSettings } from './settings';
import { pointcloudStats } from './stats';

type V3 = readonly [number, number, number];
type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

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
  /** The live cleanup recipes; default the app's (cleanup/store.ts). */
  cleanup?: StoreApi<CleanupRecipes>;
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
const rays = new WeakMap<SceneHandle, () => void>();

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

/** What a COPC file gives a layer: its chunks, size, header and framing box (local frame). */
interface LoadedCopc {
  chunks: ChunkSeed[];
  baseSize: number;
  copc: CopcLayerInfo;
  scalar: PointcloudScalar | null;
  box: Box3;
}

/** Reads a COPC file's header and root page for `layer` (its own file or its noise copy). */
async function loadCopc(
  layer: CloudLayer,
  url: string,
  origin: V3,
  m: CloudManager,
): Promise<LoadedCopc> {
  let scalar: PointcloudScalar | null = null;
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
  const chunks = copcChunkSeeds(layer.id, url, source, root, origin);
  const b = source.bounds ?? source.cube;
  // CRS to the local frame (data-conventions section 1): z = origin N - N
  const box = new Box3(
    new Vector3(b.min[0] - origin[0], b.min[2] - origin[2], origin[1] - b.max[1]),
    new Vector3(b.max[0] - origin[0], b.max[2] - origin[2], origin[1] - b.min[1]),
  );
  return { chunks, baseSize: source.spacing, copc: { url, source, origin }, scalar, box };
}

/** The noise working copy could not be read: say so and show the original. */
function noiseFailed(path: string, e: unknown): void {
  const msg = `${path}: the noise working copy could not be read (${e instanceof Error ? e.message : String(e)}); showing the original cloud`;
  console.warn(msg);
  pointcloudStats.getState().addError(msg);
}

export function createPointcloudAdapter(
  opts: PointcloudAdapterOptions = {},
): LayerAdapter<'pointcloud'> {
  const makeDecoder = opts.decoder ?? (() => createWorkerPool());
  const settings = opts.settings ?? pointcloudSettings;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const originOf = opts.origin ?? projectOrigin;
  const cleanup = opts.cleanup ?? pointcloudCleanup;
  // The newest create of each layer in a scene. The stage re-creates a layer whose definition
  // changed (a new height offset), so two creates of one id can be in flight: a stale one that
  // resolves late, or after the newer one was disposed, is dropped instead of drawn.
  let seq = 0;
  const latest = new WeakMap<SceneHandle, Map<string, number>>();

  const managerFor = (handle: SceneHandle): CloudManager => {
    let manager = managers.get(handle);
    if (!manager) {
      manager = new CloudManager(handle, makeDecoder, settings, cleanup);
      managers.set(handle, manager);
      // clouds take part in SceneHandle.raycast (cursor readout, annotation, measure)
      pickers.set(
        handle,
        handle.addRaycastProvider((x, y) => pickPoint(handle, { x, y })),
      );
      // and in SceneHandle.raycastRay by layer (placing findings from photos)
      rays.set(handle, handle.addRayProvider?.(cloudRayProvider(handle)) ?? (() => undefined));
    }
    return manager;
  };
  const release = (handle: SceneHandle, m: CloudManager) => {
    if (!m.empty) return;
    m.dispose();
    managers.delete(handle);
    pickers.get(handle)?.();
    pickers.delete(handle);
    rays.get(handle)?.();
    rays.delete(handle);
  };

  return {
    kind: 'pointcloud',
    async create(layer, ctx) {
      let chunks: ChunkSeed[];
      let baseSize: number;
      let copc: CopcLayerInfo | null = null;
      let scalar: PointcloudScalar | null = null;
      let box: Box3 | null = null;
      // COPC: the noise working copy streamed instead of the layer's file, or null
      let noisePath: string | null = null;
      const url = ctx.url(layer.src);
      const handle = ctx.scene;
      const gen = ++seq;
      let gens = latest.get(handle);
      if (!gens) {
        gens = new Map();
        latest.set(handle, gens);
      }
      gens.set(layer.id, gen);
      const newest = () => latest.get(handle)?.get(layer.id) === gen;
      /** A newer create superseded this one: add nothing and hand back a handle that does nothing. */
      const dropStale = (): LayerHandle => {
        // while that newer create is still loading it needs the scene's manager and decoder
        if (!latest.get(handle)?.has(layer.id)) {
          const stale = managers.get(handle);
          if (stale) release(handle, stale);
        }
        return { setVisible: () => undefined, dispose: () => undefined };
      };
      // the date's shift, applied here: point clouds are not moved by the engine's shiftedLayer
      const shift = ctx.shiftOf?.(layer.id) ?? null;
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
        // png-packed points are already local (y = H): the height offset lifts them as decoded
        // the date shift moves them like the COPC frame origin: x += east, z -= north
        const dy = layer.heightOffsetM ?? 0;
        const lift = (v: V3): [number, number, number] => [
          v[0] + (shift?.eastM ?? 0),
          v[1] + dy,
          v[2] - (shift?.northM ?? 0),
        ];
        chunks = idx.chunks.map((c) => ({
          key: `${layer.id}#${c.id}`,
          source: {
            kind: 'png',
            url: resolveChunkUrl(c.file, idx, url, (path) => ctx.url({ path })),
            quant: { offset: lift(c.quant.offset), scale: c.quant.scale },
          },
          points: c.points,
          bounds: { min: lift(c.bounds.min), max: lift(c.bounds.max) },
          lod: c.lod,
        }));
        baseSize = pngBaseSize(idx);
        box = new Box3(new Vector3(...lift(idx.bounds.min)), new Vector3(...lift(idx.bounds.max)));
      } else if (layer.format === 'copc') {
        const project = originOf();
        if (!project) throw new Error('A COPC layer needs the project origin');
        // the layer's height offset: decoded against [E, N, H - heightOffsetM]
        const origin = cloudFrameOrigin([...project], layer, shift);
        const m = managerFor(handle);
        noisePath = cleanup.getState().recipes[layer.id]?.noise?.path ?? null;
        try {
          let r: LoadedCopc;
          try {
            r = await loadCopc(layer, noisePath ? ctx.url({ path: noisePath }) : url, origin, m);
          } catch (e) {
            if (!noisePath) throw e;
            // noisePath keeps the failed copy, so later edits of the recipe do not retry it
            noiseFailed(noisePath, e);
            r = await loadCopc(layer, url, origin, m);
          }
          ({ chunks, baseSize, copc, scalar, box } = r);
        } catch (e) {
          // a superseded create fails quietly (its decoder may be gone with the newer layer)
          if (!newest()) return dropStale();
          release(handle, m);
          throw e;
        }
      } else {
        throw new Error(`Point cloud format "${layer.format}" is not supported yet`);
      }

      if (!newest()) return dropStale();
      const m = managerFor(handle);
      // png-packed clouds carry colour; COPC does in point formats 7 and 8
      const rgbHint =
        layer.format === 'png-packed' ||
        (copc !== null && copc.source.layout.pointDataRecordFormat !== 6);
      // the manager's state for this layer that this handle owns (a noise swap replaces it)
      let own = m.addLayer(layer.id, chunks, baseSize, rgbHint, copc, scalar);
      const owns = () => m.layers.get(layer.id) === own;
      if (!layer.visible) m.setVisible(layer.id, false);
      let shown = layer.visible;
      const framed = box;
      const unframe = framed
        ? handle.addContentBounds(() => (shown ? framed : null), { solid: true })
        : () => undefined;
      // COPC: a recipe's noise run streams its working copy; the layer is removed and added again
      let disposed = false;
      let swap = 0;
      const followNoise = (s: CleanupRecipes) => {
        const want = s.recipes[layer.id]?.noise?.path ?? null;
        if (want === noisePath) return;
        noisePath = want;
        const mine = ++swap;
        const project = originOf();
        if (!project) return;
        const origin = cloudFrameOrigin([...project], layer, shift);
        const streams = (u: string) => m.layers.get(layer.id)?.copc?.url === u;
        const show = (r: LoadedCopc) => {
          if (mine !== swap || disposed || !owns()) return;
          own = m.addLayer(layer.id, r.chunks, r.baseSize, rgbHint, r.copc, r.scalar, own.tint);
          if (!shown) m.setVisible(layer.id, false);
        };
        const target = want ? ctx.url({ path: want }) : url;
        if (streams(target)) return;
        loadCopc(layer, target, origin, m)
          .then(show)
          .catch((e: unknown) => {
            // a later swap or the layer's removal made this one moot: nothing to say
            if (!want || mine !== swap || disposed) return;
            // noisePath keeps the failed copy, so later edits of the recipe do not retry it
            noiseFailed(want, e);
            if (streams(url)) return;
            void loadCopc(layer, url, origin, m)
              .then(show)
              .catch(() => undefined);
          });
      };
      let offNoise: () => void = () => undefined;
      if (layer.format === 'copc') {
        offNoise = cleanup.subscribe(followNoise);
        // a recipe that arrived while the file was loading (a saved noise run at project open)
        followNoise(cleanup.getState());
      }
      return {
        setVisible: (v) => {
          shown = v;
          if (owns()) m.setVisible(layer.id, v);
          (handle as Partial<{ contentUpdated(): void }>).contentUpdated?.();
        },
        dispose: () => {
          disposed = true;
          offNoise();
          unframe();
          if (newest()) latest.get(handle)?.delete(layer.id);
          if (owns()) m.removeLayer(layer.id);
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

/** The COPC file a cloud layer streams now (its own, or its noise working copy). */
export function cloudSourceUrl(handle: SceneHandle, layerId: string): string | null {
  return getCloudManager(handle)?.layers.get(layerId)?.copc?.url ?? null;
}

/**
 * The low point of a shown cloud, local Y (its height offset included): the `p` percentile of the
 * heights sampled from its coarsest decoded level, so stray points below the ground are ignored.
 * Null when the layer is unknown, hidden, or has not streamed yet.
 */
export function cloudLowHeight(handle: SceneHandle, layerId: string, p = 0.02): number | null {
  return getCloudManager(handle)?.lowHeight(layerId, p) ?? null;
}

/**
 * A COPC layer's bounds in the project CRS, file heights (the header's, else the octree cube):
 * without the layer's height offset, as the cleanup recipes and the save job read them.
 */
export function cloudWorldBounds(
  handle: SceneHandle,
  layerId: string,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const s = getCloudManager(handle)?.layers.get(layerId)?.copc?.source;
  const b = s?.bounds ?? s?.cube;
  return b ? { min: [...b.min], max: [...b.max] } : null;
}
