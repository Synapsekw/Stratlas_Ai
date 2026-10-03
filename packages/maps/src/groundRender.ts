// Browser-only: the M1 3D ground for `basemap` layers. Renders the offline street style once with a
// hidden MapLibre map around the project origin, then drapes that image on a ground quad in the
// local frame. Cheap stand-in for the tiled quadtree of tech-evaluation section 5.
import type { AdapterContext, LayerHandle } from '@aio/engine';
import type { AioBridge, Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Map as MapLibreMap } from 'maplibre-gl';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import { frameProjection } from './geo';
import { groundCorners, siteBbox } from './ground';
import { installBasemap } from './runtime';
import { buildStyle } from './style';

const SIZE_PX = 2048;
const HALF_SIZE_M = 2500;

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

export async function createGround(
  layer: Extract<Layer, { kind: 'basemap' }>,
  ctx: AdapterContext,
): Promise<LayerHandle> {
  const project = workspace.getState().project;
  const proj = project ? frameProjection(project.manifest.crs, project.manifest.origin) : null;
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!proj || !aio) throw new Error('Basemap ground needs an open project in a supported CRS');
  const packs = await aio.invoke('packs:list', {});
  if (!packs.length) throw new Error('No map packs installed');
  installBasemap(packs);

  const bbox = siteBbox(proj, HALF_SIZE_M);
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-${SIZE_PX * 2}px;top:0;width:${SIZE_PX}px;height:${SIZE_PX}px;pointer-events:none`;
  document.body.appendChild(host);
  const map = new MapLibreMap({
    container: host,
    style: buildStyle({ lang: 'en', maxZoom: Math.max(...packs.map((p) => p.maxZoom)) }),
    bounds: [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    fitBoundsOptions: { padding: 0 },
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  let canvas: HTMLCanvasElement;
  try {
    await waitIdle(map);
    // The rendered bounds are what the image shows (fitBounds keeps aspect, so read them back).
    const b = map.getBounds();
    bbox[0] = b.getWest();
    bbox[1] = b.getSouth();
    bbox[2] = b.getEast();
    bbox[3] = b.getNorth();
    canvas = document.createElement('canvas');
    const src = map.getCanvas();
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.getContext('2d')?.drawImage(src, 0, 0);
  } finally {
    map.remove();
    host.remove();
  }

  const [tl, tr, br, bl] = groundCorners(bbox, proj, -0.2);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([...tl, ...tr, ...br, ...bl]), 3),
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  geometry.setIndex([0, 3, 1, 1, 3, 2]);
  geometry.computeVertexNormals();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = ctx.scene.renderer.capabilities.getMaxAnisotropy();
  const material = new MeshBasicMaterial({ map: texture });
  const mesh = new Mesh(geometry, material);
  mesh.name = `basemap:${layer.id}`;
  mesh.renderOrder = -1;
  mesh.visible = layer.visible;
  ctx.scene.scene.add(mesh);
  ctx.scene.requestRender();

  return {
    setVisible: (v) => {
      mesh.visible = v;
      ctx.scene.requestRender();
    },
    dispose: () => {
      ctx.scene.scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      ctx.scene.requestRender();
    },
  };
}
