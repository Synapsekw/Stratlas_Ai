// Browser-only: the street map under a site in 3D as nested rings. One hidden MapLibre map draws
// the offline street style over each square of the local frame in turn, nearest first, and each
// picture is draped on its own mesh: a quad for the near ring, a frame around the ring inside it
// for the others (`ringGeometry`), all at one height, so the ground is sharp under the site, runs
// out to the horizon and nothing is drawn twice. Stands in for the tiled quadtree of
// tech-evaluation section 5 until that is built.
import type { AdapterContext, LayerHandle } from '@aio/engine';
import type { AioBridge, Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Map as MapLibreMap } from 'maplibre-gl';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import { frameProjection } from './geo';
import { extentBbox, ringGeometry, type GroundExtent } from './ground';
import type { Bbox } from './packs';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

const SIZE_PX = 2048;
/** The rings are built this far under the frame's zero height; the caller moves the group. */
const GROUND_Y = -0.2;

export interface GroundRingsOptions {
  /** The squares of the local frame to cover, nearest first; each contains the one before it. */
  extents: readonly GroundExtent[];
  /** Pixels across each ring's picture (default 2048). */
  sizePx?: number;
  /** A ring is in the scene (0 is the nearest). */
  onRing?: (mesh: Mesh, index: number) => void;
}

export interface GroundRingsHandle extends LayerHandle {
  /** Holds the rings; named `basemap:<layer id>`, in the scene from the first ring on. */
  readonly group: Group;
  /** Resolves when every ring is in the scene, or drawing stopped (disposed, a ring failed). */
  readonly done: Promise<void>;
}

/** Resolves when every tile is drawn, or after `timeoutMs` (a hidden window renders nothing). */
function waitIdle(map: MapLibreMap, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Lets the scene draw a frame between two rings. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function createGroundRings(
  layer: Extract<Layer, { kind: 'basemap' }>,
  ctx: AdapterContext,
  opts: GroundRingsOptions,
): Promise<GroundRingsHandle> {
  const project = workspace.getState().project;
  const proj = project ? frameProjection(project.manifest.crs, project.manifest.origin) : null;
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!proj || !aio) throw new Error('Street map ground needs an open project in a supported CRS');
  const packs = await aio.invoke('packs:list', {});
  if (!packs.length) throw new Error('No map packs installed');
  installBasemap(packs);

  const size = opts.sizePx ?? SIZE_PX;
  const group = new Group();
  group.name = `basemap:${layer.id}`;
  group.visible = layer.visible;
  const state = { disposed: false };
  /** Asked again after every wait: `dispose` may run while a ring is being drawn. */
  const gone = (): boolean => state.disposed;
  const bounds = (b: Bbox): [[number, number], [number, number]] => [
    [b[0], b[1]],
    [b[2], b[3]],
  ];

  const draw = async (): Promise<void> => {
    const [first] = opts.extents;
    if (!first) return;
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-${String(size * 2)}px;top:0;width:${String(size)}px;height:${String(size)}px;pointer-events:none`;
    document.body.appendChild(host);
    const map = new MapLibreMap({
      container: host,
      // Always the dark street style, as on every map of the app.
      style: buildStyle({ lang: 'en', maxZoom: Math.max(...packs.map((p) => p.maxZoom)) }),
      bounds: bounds(extentBbox(proj, first)),
      fitBoundsOptions: { padding: 0 },
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    try {
      let hole: Bbox | null = null;
      for (const [i, extent] of opts.extents.entries()) {
        if (i > 0) {
          map.fitBounds(bounds(extentBbox(proj, extent)), { padding: 0, animate: false });
          map.triggerRepaint();
        }
        await waitIdle(map);
        if (gone()) return;
        // The rendered bounds are what the picture shows (fitBounds keeps aspect, so read them).
        const b = map.getBounds();
        const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        const canvas = document.createElement('canvas');
        const src = map.getCanvas();
        canvas.width = src.width;
        canvas.height = src.height;
        canvas.getContext('2d')?.drawImage(src, 0, 0);

        const ring = ringGeometry(bbox, hole, proj, GROUND_Y);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(ring.positions, 3));
        geometry.setAttribute('uv', new BufferAttribute(ring.uvs, 2));
        geometry.setIndex(ring.indices);
        geometry.computeVertexNormals();
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = ctx.scene.renderer.capabilities.getMaxAnisotropy();
        const mesh = new Mesh(geometry, new MeshBasicMaterial({ map: texture }));
        mesh.name = `${group.name}:ring-${String(i)}`;
        mesh.renderOrder = -1;
        group.add(mesh);
        if (i === 0) ctx.scene.scene.add(group);
        opts.onRing?.(mesh, i);
        ctx.scene.requestRender();
        hole = bbox;
        await nextTask();
        if (gone()) return;
      }
    } finally {
      map.remove();
      host.remove();
    }
  };

  const done = draw().catch((e: unknown) => {
    console.warn('Street map ring not drawn', e);
  });

  return {
    group,
    done,
    setVisible: (v) => {
      group.visible = v;
      ctx.scene.requestRender();
    },
    dispose: () => {
      state.disposed = true;
      ctx.scene.scene.remove(group);
      for (const child of [...group.children]) {
        const mesh = child as Mesh<BufferGeometry, MeshBasicMaterial>;
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.map?.dispose();
        mesh.material.dispose();
      }
      ctx.scene.requestRender();
    },
  };
}
