import type { Layer } from '@aio/schema';
import type { MeshLambertMaterial } from 'three';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
} from 'three';
import { GROUND_LAYER, groundImageryMaterial, type GroundUniforms } from '../stage/groundShading';
import type { AdapterContext, LayerAdapter, LayerHandle, SceneHandle } from '../types';
import {
  QUAD_INDEX,
  QUAD_UVS,
  parseTileIndex,
  planTiles,
  quadPositions,
  tileCorners,
  tileUrl,
  type Corners,
  type TileIndex,
} from './rasterMath';

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
export type RasterFormatHandler = (layer: RasterLayer, ctx: AdapterContext) => Promise<LayerHandle>;

const formatHandlers = new Map<RasterLayer['format'], RasterFormatHandler>();

/**
 * Only one adapter may own a layer kind, so other streams (maps: cog, pmtiles) plug their raster
 * formats into the engine's raster adapter here instead of registering a second one.
 */
export function registerRasterFormat(format: RasterLayer['format'], handler: RasterFormatHandler) {
  formatHandlers.set(format, handler);
}

/** Ground shading the engine's own stage offers (other SceneHandle implementations lack it). */
function groundUniforms(scene: SceneHandle): GroundUniforms | undefined {
  return (scene as Partial<{ groundUniforms(): GroundUniforms }>).groundUniforms?.();
}

/**
 * Plot plans are line art with alpha (transparent background): drawn with normal alpha blending
 * over the ortho, without writing depth. Photographic rasters (ortho, dsm) stay opaque.
 */
function quadMesh(
  c: Corners,
  tex: Texture | null,
  ctx: AdapterContext,
  order: number,
  overlay = false,
): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(quadPositions(c), 3));
  g.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
  );
  g.setAttribute('uv', new BufferAttribute(QUAD_UVS.slice(), 2));
  g.setIndex(QUAD_INDEX);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // photographed ground takes the time of day, the sun's shadows and the water's land mask
  const ground = overlay ? undefined : groundUniforms(ctx.scene);
  const m: MeshBasicMaterial | MeshLambertMaterial = ground
    ? groundImageryMaterial(tex, ground, { masked: true })
    : new MeshBasicMaterial({ map: tex, toneMapped: false });
  m.side = DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2 - order;
  m.polygonOffsetUnits = -2 - order;
  if (overlay) {
    m.transparent = true;
    m.depthWrite = false;
  }
  m.userData.aioKeepSide = true;
  m.clippingPlanes = ctx.scene.clippingPlanes;
  const mesh = new Mesh(g, m);
  mesh.receiveShadow = ground !== undefined;
  // imagery tells the land mask where the sea is
  if (ground) mesh.layers.enable(GROUND_LAYER);
  mesh.renderOrder = -4 + order;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function disposeQuad(mesh: Mesh) {
  mesh.geometry.dispose();
  const m = mesh.material as MeshBasicMaterial | MeshLambertMaterial;
  m.map?.dispose();
  m.dispose();
}

type DecodeReply = { id: number; bitmap: ImageBitmap } | { id: number; error: string };

interface ImageDecoder {
  worker: Worker;
  next: number;
  pending: Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>;
}

/** One shared decode worker (imageDecode.worker.ts), started on first use. */
let decoder: ImageDecoder | null = null;

function decodeInWorker(url: string): Promise<ImageBitmap> {
  if (!decoder) {
    const worker = new Worker(new URL('./imageDecode.worker.ts', import.meta.url), {
      type: 'module',
      name: 'image-decode',
    });
    const d: ImageDecoder = { worker, next: 1, pending: new Map() };
    worker.onmessage = (e: MessageEvent<DecodeReply>) => {
      const p = d.pending.get(e.data.id);
      if (!p) return;
      d.pending.delete(e.data.id);
      if ('bitmap' in e.data) p.resolve(e.data.bitmap);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of d.pending.values()) p.reject(new Error(e.message || 'Image decode failed'));
      d.pending.clear();
    };
    decoder = d;
  }
  const d = decoder;
  const id = d.next++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    d.pending.set(id, { resolve, reject });
    d.worker.postMessage({ id, url });
  });
}

/**
 * The image decoded in a worker (createImageBitmap there), so its first frame only uploads it:
 * an <img> texture is decoded synchronously inside the upload, 40 to 350 ms for a 2048 px ortho
 * tile, which stalls the frame that first draws it.
 */
async function loadImage(url: string): Promise<Texture> {
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function')
    return new TextureLoader().loadAsync(url);
  // decoded flipped: an ImageBitmap ignores UNPACK_FLIP_Y
  const bmp = await decodeInWorker(url);
  const tex = new Texture(bmp);
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.addEventListener('dispose', () => {
    bmp.close();
  });
  return tex;
}

async function loadTexture(url: string, ctx: AdapterContext): Promise<Texture> {
  const tex = await loadImage(url);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = Math.min(8, ctx.scene.renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** `format: 'image'`: one textured ground quad from the layer corners. */
async function imageRaster(layer: RasterLayer, ctx: AdapterContext): Promise<LayerHandle> {
  if (!layer.corners) throw new Error(`Raster "${layer.name}" has no corners`);
  const tex = await loadTexture(ctx.url(layer.src), ctx);
  const mesh = quadMesh(
    layer.corners,
    tex,
    ctx,
    layer.role === 'plan' ? 2 : 0,
    layer.role === 'plan',
  );
  mesh.name = `layer:${layer.id}`;
  mesh.userData.aioRaster = true;
  mesh.userData.aioLayer = layer.id;
  ctx.scene.scene.add(mesh);
  mesh.updateMatrixWorld(true);
  // video drapes on the ground imagery, not on line art overlays (it would paint the frame over
  // their transparent background)
  const unregister = [
    ctx.scene.addRaycastTarget(mesh, layer.id),
    ...(layer.role === 'plan' ? [] : [ctx.scene.addProjectionReceiver(mesh)]),
  ];
  ctx.scene.requestRender();
  return {
    setVisible(v) {
      mesh.visible = v;
      ctx.scene.requestRender();
    },
    dispose() {
      for (const u of unregister) u();
      ctx.scene.scene.remove(mesh);
      disposeQuad(mesh);
      ctx.scene.requestRender();
    },
  };
}

/** `format: 'kit-pyramid'`: coarse level resident, finer tiles streamed around the view. */
async function pyramidRaster(layer: RasterLayer, ctx: AdapterContext): Promise<LayerHandle> {
  const res = await fetch(ctx.url(layer.src));
  if (!res.ok) throw new Error(`Tile index for "${layer.name}" not found (${res.status})`);
  const index: TileIndex = parseTileIndex(await res.json());
  const group = new Group();
  group.name = `layer:${layer.id}`;
  group.userData.aioRaster = true;
  group.userData.aioLayer = layer.id;
  ctx.scene.scene.add(group);
  const tiles = new Map<string, Mesh | null>(); // null while loading
  // decoded tiles waiting for their frame: one new tile (one texture upload) per frame
  const arrived: { key: string; mesh: Mesh }[] = [];
  const byZ = new Map(index.levels.map((l, i) => [l.z, { level: l, order: i }]));
  let disposed = false;
  let tick = 0;
  const target = new Vector3();
  const dir = new Vector3();

  const viewTarget = (): [Vector3, number] => {
    const controls = (ctx.scene as { controls?: { target: Vector3 } }).controls;
    const cam = ctx.scene.camera;
    if (controls) return [target.copy(controls.target), cam.position.distanceTo(controls.target)];
    cam.getWorldDirection(dir);
    const t = dir.y < -1e-3 ? -cam.position.y / dir.y : cam.position.y;
    target.copy(cam.position).addScaledVector(dir, t);
    return [target, cam.position.distanceTo(target)];
  };

  const update = (force: boolean) => {
    if (disposed || !group.visible) return;
    if (!force && ++tick % 15) return;
    const [t, d] = viewTarget();
    const loaded = new Set(tiles.keys());
    const plan = planTiles(index, [t.x, t.y, t.z], d, loaded);
    for (const k of plan.drop) {
      const mesh = tiles.get(k);
      tiles.delete(k);
      if (mesh) {
        group.remove(mesh);
        disposeQuad(mesh);
        ctx.scene.requestRender();
      }
    }
    for (const k of plan.load) {
      const [z, x, y] = k.split('/').map(Number) as [number, number, number];
      const info = byZ.get(z);
      if (!info) continue;
      tiles.set(k, null);
      const c = tileCorners(index.corners, info.level.cols, info.level.rows, x, y);
      loadTexture(ctx.url({ path: tileUrl(info.level.pattern, z, x, y) }), ctx).then(
        (tex) => {
          if (disposed || !tiles.has(k)) {
            tex.dispose();
            return;
          }
          const mesh = quadMesh(
            c,
            tex,
            ctx,
            layer.role === 'plan' ? info.order + 2 : info.order,
            layer.role === 'plan',
          );
          mesh.updateMatrixWorld(true);
          arrived.push({ key: k, mesh });
          ctx.scene.requestRender();
        },
        () => {
          tiles.delete(k);
        },
      );
    }
  };

  // an invisible quad over the whole placement gives the layer its bounds
  const base = quadMesh(index.corners, null, ctx, -1);
  base.visible = false;
  group.add(base);
  group.updateMatrixWorld(true);
  const unregister = [
    ctx.scene.addRaycastTarget(group, layer.id),
    ctx.scene.onFrame(() => {
      const next = arrived.shift();
      if (next) {
        if (tiles.has(next.key) && tiles.get(next.key) === null) {
          group.add(next.mesh);
          tiles.set(next.key, next.mesh);
        } else disposeQuad(next.mesh);
        if (arrived.length) ctx.scene.requestRender();
      }
      update(false);
    }),
  ];
  update(true);
  return {
    setVisible(v) {
      group.visible = v;
      if (v) update(true);
      ctx.scene.requestRender();
    },
    dispose() {
      disposed = true;
      for (const u of unregister) u();
      ctx.scene.scene.remove(group);
      for (const m of tiles.values()) if (m) disposeQuad(m);
      for (const a of arrived.splice(0)) disposeQuad(a.mesh);
      disposeQuad(base);
      tiles.clear();
      ctx.scene.requestRender();
    },
  };
}

/** Raster layers: image and kit-pyramid here; other formats through registerRasterFormat. */
export const rasterAdapter: LayerAdapter<'raster'> = {
  kind: 'raster',
  create(layer, ctx) {
    const plugged = formatHandlers.get(layer.format);
    if (plugged) return plugged(layer, ctx);
    if (layer.format === 'image') return imageRaster(layer, ctx);
    if (layer.format === 'kit-pyramid') return pyramidRaster(layer, ctx);
    return Promise.reject(new Error(`Raster format "${layer.format}" has no renderer yet`));
  },
};
