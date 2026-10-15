/**
 * The live side of placing findings: the 3D view as the projector's scene (with the point
 * cloud's refine and prism queries), the pixel size of photos no viewer has opened yet, and
 * waiting for a layer to be ready for rays. No bridge here, so it is testable in node.
 */
import {
  imageSizeOf,
  placeOnLayer,
  rememberImageSize,
  type CameraSources,
  type PlaceResult,
  type PlaceScene,
} from '@aio/annotate';
import { getActiveScene, type SceneHandle } from '@aio/engine';
import { pointsInPrism, refineAround } from '@aio/pointcloud';
import type { Issue, Layer, Vec2 } from '@aio/schema';
import { assetUrl, type Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';

export type Refine = typeof refineAround;

/**
 * The 3D view as the projector's scene. Every refine hold handed out is added to `holds` (and
 * taken out when released), so the caller can hand back any the projection kept.
 */
export function placeScene(
  h: SceneHandle,
  holds?: Set<() => void>,
  refine: Refine = refineAround,
): PlaceScene {
  return {
    raycastRay: (o, d, opts) => h.raycastRay(o, d, opts),
    rayLayers: () => h.rayLayers?.() ?? new Set<string>(),
    cloud: {
      refineAround: async (focus, ms) => {
        const r = await refine(h, focus, ms);
        const release = () => {
          holds?.delete(release);
          r.release();
        };
        holds?.add(release);
        return { depth: r.depth, release };
      },
      pointsInPrism: (layer, prism) => pointsInPrism(h, layer, prism),
    },
  };
}

/**
 * Project an issue onto a layer of the 3D view. A refine keeps the cloud's render hold until it
 * is released, so whatever way the projection ends (a result or a throw) every hold it took is
 * handed back here.
 */
export async function placeOnScene(
  issue: Issue,
  layer: Layer,
  h: SceneHandle,
  src: CameraSources,
  run: typeof placeOnLayer = placeOnLayer,
  refine: Refine = refineAround,
): Promise<PlaceResult> {
  const holds = new Set<() => void>();
  try {
    return await run(issue, layer, placeScene(h, holds, refine), src);
  } finally {
    for (const release of [...holds]) release();
  }
}

export type ProbeSize = (url: string) => Promise<Vec2 | null>;

/** The natural size of an image file (the size the photo viewer measures shapes in). */
export const probeImageSize: ProbeSize = (url) =>
  new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      resolve([im.naturalWidth, im.naturalHeight]);
    };
    im.onerror = () => {
      resolve(null);
    };
    im.src = url;
  });

/** Remember the pixel size of each photo the issue is marked on that no viewer has shown yet. */
export async function ensureSizes(
  ws: StoreApi<Workspace>,
  issue: Issue,
  probe: ProbeSize = probeImageSize,
): Promise<void> {
  const project = ws.getState().project;
  if (!project) return;
  for (const s of issue.sightings) {
    if (s.on !== 'image' || imageSizeOf(s.layer, s.photo)) continue;
    const layer = project.manifest.layers.find((l) => l.id === s.layer);
    const photo = layer?.kind === 'photos' ? layer.items.find((p) => p.id === s.photo) : undefined;
    if (!photo) continue;
    const size = await probe(assetUrl(project.id, photo.src));
    if (size) rememberImageSize(s.layer, s.photo, size);
  }
}

/**
 * Show the layer when hidden, then wait until the 3D view can cast rays at it. A 3D view that is
 * still mounting (the app has just switched to it) is waited for within the same timeout.
 */
export async function layerReady(
  ws: StoreApi<Workspace>,
  layerId: string,
  scene: () => SceneHandle | null = getActiveScene,
  timeoutMs = 15_000,
  stepMs = 100,
): Promise<boolean> {
  const s = ws.getState();
  if (s.hidden[layerId]) s.setLayerVisible(layerId, true);
  const end = Date.now() + timeoutMs;
  const has = () => scene()?.rayLayers?.().has(layerId) === true;
  while (Date.now() < end) {
    if (has()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return has();
}
