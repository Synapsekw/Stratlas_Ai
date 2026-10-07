import type { SceneHandle } from '@aio/engine';
import type { TilesetEntry } from '@aio/schema';
import { Matrix4, type Material, type Object3D } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
// Deep import on purpose: the plugins bundle also holds the Cesium ion and Google providers,
// whose online host names the offline bundle check refuses (decision 3: no online providers).
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/src/three/plugins/GLTFExtensionsPlugin.js';
import type { TilesBudget } from './budgets';
import { applyM4, type M4, type SiteFrame, type V3 } from './frame';

/**
 * 3D Tiles in the site view (M10 G7, decision 3): one 3DTilesRendererJS `TilesRenderer` per
 * `tilesets.json` entry, inside the engine's scene and its tools.
 *
 * - Placement: an entry's own `transform` (imported tilesets the person placed), else our ECEF
 *   tilesets through the project CRS: the tileset group takes the matrix fitted at the origin
 *   and every loaded tile is re-placed with the matrix fitted at its own centre (`frame.ts`).
 * - Budgets per graphics tier: `errorTarget` and the tile cache size (`budgets.ts`).
 * - Tools: the tileset is a raycast target (picking, issues, measuring; hits name the mesh layer
 *   it was made from, else `tileset:<id>`), its materials take the stage's section planes (the
 *   cutaway), and loading asks the stage to redraw.
 * - Offline: tiles load from `aio://` only; Meshopt is decoded by the bundled decoder; Draco and
 *   KTX2 are not offered (the engine's mesh adapter refuses Draco the same way).
 */

/** The slice of `TilesRenderer` the adapter uses (a fake in tests). */
export interface TilesLike {
  group: Object3D;
  errorTarget: number;
  lruCache: { maxBytesSize: number; minBytesSize: number };
  loadProgress: number;
  setCamera(camera: unknown): boolean;
  setResolutionFromRenderer(camera: unknown, renderer: unknown): boolean;
  registerPlugin(plugin: object): void;
  addEventListener(name: string, cb: (e: { scene?: Object3D }) => void): void;
  update(): void;
  dispose(): void;
}

/** A tile as the renderer hands it to `processTileModel`. */
interface TileModelTile {
  boundingVolume?: { box?: number[] };
  engineData?: { transform?: { elements: ArrayLike<number> } };
}

export interface TilesetOptions {
  /** The `aio://` URL of the root `tileset.json`. */
  url: string;
  entry: TilesetEntry;
  /** The project's frame; null when the CRS is not known offline (only `transform` places it). */
  frame: SiteFrame | null;
  budget: TilesBudget;
  /** Make the renderer (tests pass a fake). */
  create?: (url: string) => TilesLike;
}

export interface TilesetHandle {
  readonly tiles: TilesLike;
  /** The layer id hits report. */
  readonly pickId: string;
  setVisible(visible: boolean): void;
  setBudget(budget: TilesBudget): void;
  dispose(): void;
}

const PLUGIN_NAME = 'AIO_SITE_FRAME';

export function defaultTiles(url: string): TilesLike {
  const tiles = new TilesRenderer(url);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ meshoptDecoder: MeshoptDecoder }));
  return tiles;
}

/** The tileset group's matrix: the entry's own placement, else the CRS fit at the origin. */
export function groupMatrix(entry: TilesetEntry, frame: SiteFrame | null): M4 {
  if (entry.transform) return [...entry.transform];
  if (frame) return frame.ecefToLocalAt(frame.localToEcef([0, 0, 0]));
  return new Matrix4().identity().toArray();
}

/** The matrix that places one loaded tile: its own CRS fit (relative to the group). */
export function tileMatrix(frame: SiteFrame, group: M4, tile: TileModelTile, sceneMatrix: M4): M4 {
  const box = tile.boundingVolume?.box;
  const centre: V3 = box && box.length >= 3 ? [box[0] ?? 0, box[1] ?? 0, box[2] ?? 0] : [0, 0, 0];
  const t = tile.engineData?.transform?.elements;
  const ecef = t ? applyM4(Array.from(t), centre) : centre;
  const fit = new Matrix4().fromArray(frame.ecefToLocalAt(ecef));
  const inv = new Matrix4().fromArray(group).invert();
  return inv.multiply(fit).multiply(new Matrix4().fromArray(sceneMatrix)).toArray();
}

function forMaterials(o: Object3D, fn: (m: Material) => void): void {
  o.traverse((c) => {
    const mat = (c as { material?: Material | Material[] }).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) fn(m);
  });
}

export function attachTileset(scene: SceneHandle, opts: TilesetOptions): TilesetHandle {
  const { entry, frame } = opts;
  const tiles = (opts.create ?? defaultTiles)(opts.url);
  const pickId = entry.from ?? `tileset:${entry.id}`;
  const group = groupMatrix(entry, frame);

  tiles.group.name = `tileset:${entry.id}`;
  tiles.group.userData.layerId = pickId;
  tiles.group.userData.tilesetId = entry.id;
  tiles.group.matrixAutoUpdate = false;
  tiles.group.matrix.fromArray(group);
  tiles.group.updateMatrixWorld(true);
  tiles.group.visible = entry.visible;

  const applyBudget = (b: TilesBudget) => {
    tiles.errorTarget = b.errorTarget;
    tiles.lruCache.maxBytesSize = b.maxBytes;
    tiles.lruCache.minBytesSize = Math.round(b.maxBytes * 0.6);
  };
  applyBudget(opts.budget);

  tiles.registerPlugin({
    name: PLUGIN_NAME,
    processTileModel(model: Object3D, tile: TileModelTile) {
      if (!entry.transform && frame) {
        const m = tileMatrix(frame, group, tile, model.matrix.toArray());
        model.matrix.fromArray(m);
        model.matrixAutoUpdate = false;
      }
      forMaterials(model, (m) => {
        m.clippingPlanes = scene.clippingPlanes;
        m.clipShadows = true;
      });
      model.traverse((c) => {
        c.userData.layerId = pickId;
      });
      return Promise.resolve();
    },
  });

  tiles.setCamera(scene.camera);
  tiles.setResolutionFromRenderer(scene.camera, scene.renderer);
  scene.scene.add(tiles.group);
  const offTarget = scene.addRaycastTarget(tiles.group, pickId);
  const redraw = () => {
    scene.requestRender();
  };
  tiles.addEventListener('load-model', redraw);
  tiles.addEventListener('tiles-load-end', redraw);
  tiles.addEventListener('needs-update', redraw);

  let disposed = false;
  const offFrame = scene.onFrame(() => {
    if (disposed || !tiles.group.visible) return;
    scene.camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(scene.camera, scene.renderer);
    tiles.update();
    // keep refining while tiles are on their way
    if (tiles.loadProgress < 1) scene.requestRender();
  });
  scene.requestRender();

  return {
    tiles,
    pickId,
    setVisible(visible) {
      tiles.group.visible = visible;
      scene.requestRender();
    },
    setBudget(b) {
      applyBudget(b);
      scene.requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offFrame();
      offTarget();
      scene.scene.remove(tiles.group);
      tiles.dispose();
      scene.requestRender();
    },
  };
}
