/**
 * The offline street map under the site in 3D: the maps package's street rings (the app's street
 * style rendered from the installed PMTiles packs, sharp near the site and out to the horizon),
 * added for projects placed on the Earth whose manifest has no basemap layer of its own. It
 * covers what the project covers (models, clouds, flight paths, photo places, the origin) and
 * stands in for the plain ground. On for every project until turned off with the stage toolbar's
 * street map button, a choice remembered per project on this computer. It gives way to imagery
 * and terrain around the site from packs. Nothing is drawn, and nothing fails, when no installed
 * pack covers the site.
 */
import type { EngineStage } from '@aio/engine';
import {
  createStreetRings,
  frameProjection,
  packCovers,
  type GroundExtent,
  type GroundRingsHandle,
} from '@aio/maps';
import type { AioBridge, Layer, MapPackInfo, ProjectManifest, Vec3 } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import { loadFlight } from '@aio/video';
import { assetUrl } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useGraphics } from '../graphics';
import type { GroundModel } from './basemap';

/** Id of the street map ground (never a manifest layer id: those are the project's own). */
export const SITE_BASEMAP_ID = 'site-street-map';
/** The pack must reach this zoom for streets to read at site scale. */
const MIN_ZOOM = 12;
const KEY = 'stratlas.streetMap3d';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readChoices(): Record<string, boolean> {
  try {
    const v = JSON.parse(storage()?.getItem(KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, boolean] => typeof e[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

interface SiteBasemapState {
  /** Choices made per project (absent: on). */
  choices: Record<string, boolean>;
  /** The open project has a covering pack: null while unknown. */
  covered: boolean | null;
  /** The rings the main view draws for a project, as JSON: a second view draws the same. */
  rings: { projectId: string; json: string } | null;
  setRings(projectId: string, json: string): void;
  set(projectId: string, on: boolean): void;
  setCovered(covered: boolean | null): void;
}

export const siteBasemap = createStore<SiteBasemapState>()((set, get) => ({
  choices: readChoices(),
  covered: null,
  rings: null,
  set(projectId, on) {
    const choices = { ...get().choices, [projectId]: on };
    set({ choices });
    try {
      storage()?.setItem(KEY, JSON.stringify(choices));
    } catch {
      // blocked storage: the choice lasts for this session
    }
  },
  setCovered(covered) {
    set({ covered });
  },
  setRings(projectId, json) {
    const cur = get().rings;
    if (cur?.projectId === projectId && cur.json === json) return;
    set({ rings: { projectId, json } });
  },
}));

export function useSiteBasemap<T>(selector: (s: SiteBasemapState) => T): T {
  return useStore(siteBasemap, selector);
}

/** A project placed on the Earth (a projected CRS) with no basemap layer of its own. */
export function wantsSiteBasemap(manifest: ProjectManifest): boolean {
  if (!('epsg' in manifest.crs)) return false;
  return !manifest.layers.some((l) => l.kind === 'basemap');
}

/** The remembered choice for the project, else on. */
export function siteBasemapOn(choices: Record<string, boolean>, projectId: string): boolean {
  return choices[projectId] ?? true;
}

/** Street map margin around the content, and its smallest and largest half size, metres. */
const MARGIN = 1.25;
const PAD_M = 150;
const MIN_HALF_M = 400;
const MAX_HALF_M = 6000;

/**
 * The square of the local frame the near ring of the street map covers: the content (models,
 * clouds, flight paths, photo places) and the origin with a margin, at least MIN_HALF_M, at most
 * MAX_HALF_M. Rounded to 50 m so small additions do not redraw it.
 */
export function streetMapExtent(points: readonly Vec3[]): GroundExtent {
  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;
  for (const [x, , z] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const step = 50;
  const cx = Math.round((minX + maxX) / 2 / step) * step;
  const cz = Math.round((minZ + maxZ) / 2 / step) * step;
  const span = Math.max(maxX - cx, cx - minX, maxZ - cz, cz - minZ);
  const half = Math.min(
    MAX_HALF_M,
    Math.max(MIN_HALF_M, Math.ceil((span * MARGIN + PAD_M) / step) * step),
  );
  return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
}

/** A box on the ground (the stage's content box). */
export interface BoxLike {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/** The corners of a content box, as points for `streetMapExtent`. */
export function boxPoints(box: BoxLike): Vec3[] {
  return [
    [box.min.x, 0, box.min.z],
    [box.max.x, 0, box.min.z],
    [box.max.x, 0, box.max.z],
    [box.min.x, 0, box.max.z],
  ];
}

/** Each ring is this many times the size of the ring inside it. */
const RING_STEP = 4;
/** No ring reaches further from its centre than this, metres (the camera sees 20 km). */
const MAX_RING_HALF_M = 12_000;
/** A ring less than this many times the ring inside it adds too little to be drawn. */
const MIN_RING_GROWTH = 1.5;

/**
 * The squares the street map is drawn in, nearest first: `near` (sharp, under the content), then
 * up to two more around the same centre, so the map runs out to the horizon without one picture
 * having to cover everything.
 */
export function streetMapRings(near: GroundExtent): GroundExtent[] {
  const cx = (near.minX + near.maxX) / 2;
  const cz = (near.minZ + near.maxZ) / 2;
  const half = (near.maxX - near.minX) / 2;
  const rings = [near];
  let last = half;
  for (let k = 1; k <= 2; k++) {
    const h = Math.min(MAX_RING_HALF_M, half * RING_STEP ** k);
    if (h < last * MIN_RING_GROWTH) break;
    rings.push({ minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h });
    last = h;
  }
  return rings;
}

/**
 * Wait for the scene to be up: `done` gets the content box once two readings `stepMs` apart are
 * the same (to the metre), or whatever it is after `capMs` (null for a project with nothing in
 * it yet). The street map is drawn after that, so it never holds up the first frames, and is
 * sized by what was loaded. Returns a function that stops the wait.
 */
export function settledBox<B extends BoxLike>(
  read: () => B | null,
  done: (box: B | null) => void,
  stepMs = 300,
  capMs = 2400,
): () => void {
  let last: string | null = null;
  let waited = 0;
  const timer = setInterval(() => {
    waited += stepMs;
    const box = read();
    const key = box
      ? [box.min.x, box.min.z, box.max.x, box.max.z].map((v) => Math.round(v)).join()
      : null;
    if ((key !== null && key === last) || waited >= capMs) {
      clearInterval(timer);
      done(box);
      return;
    }
    last = key;
  }, stepMs);
  return () => {
    clearInterval(timer);
  };
}

/**
 * Imagery or terrain around the site is drawn (the landscape from packs, `siteTiles.ts`): the
 * street map gives way, because the landscape follows the terrain and a flat map would cut
 * through it.
 */
export function landscapeOn(
  prefs: { aroundTerrain: boolean; aroundImagery: boolean },
  ground: GroundModel,
): boolean {
  return (
    ground.offered &&
    ((prefs.aroundTerrain && ground.terrain) || (prefs.aroundImagery && ground.imagery))
  );
}

/** The street map of the open project's 3D view, for the layer and its button. */
export interface StreetMap3d {
  projectId: string | null;
  /** The project can have it (placed on the Earth, no basemap layer of its own). */
  wanted: boolean;
  /** The choice: remembered, else on. */
  on: boolean;
  /** A pack covers the site: null while unknown. */
  covered: boolean | null;
  /** The landscape from packs is drawn instead. */
  landscape: boolean;
  /** Draw it (given a covering pack). */
  shown: boolean;
}

/** The toolbar button: its label, whether it is pressed or greyed out; null when there is none. */
export function streetMapTool(
  s: StreetMap3d,
): { label: MessageKey; pressed: boolean; disabled: boolean } | null {
  if (!s.projectId || !s.wanted) return null;
  if (s.covered === false) return { label: 'stage.streetMap.none', pressed: false, disabled: true };
  if (s.landscape) return { label: 'stage.streetMap.landscape', pressed: false, disabled: true };
  return {
    label: s.on ? 'stage.streetMap.hide' : 'stage.streetMap.show',
    pressed: s.on,
    disabled: false,
  };
}

/** Every tenth flight pose and every photo place of the project's video and photo layers. */
async function contentPoints(projectId: string, manifest: ProjectManifest): Promise<Vec3[]> {
  const points: Vec3[] = [];
  for (const l of manifest.layers) {
    if (l.kind === 'photos') for (const p of l.items) if (p.pos) points.push(p.pos);
  }
  const videos = manifest.layers.filter((l) => l.kind === 'video');
  await Promise.all(
    videos.map(async (l) => {
      try {
        const flight = await loadFlight(assetUrl(projectId, l.flight.src));
        flight.samples.forEach((s, i) => {
          if (i % 10 === 0) points.push(s.pos);
        });
      } catch {
        // a clip without a readable flight log does not place the street map
      }
    }),
  );
  return points;
}

/** The detailed pack that covers the site origin, if any. */
export function coveringPack(
  packs: readonly MapPackInfo[],
  manifest: ProjectManifest,
): MapPackInfo | null {
  const proj = frameProjection(manifest.crs, manifest.origin);
  if (!proj) return null;
  const [lon, lat] = proj.toLonLat([0, 0, 0]);
  return (
    packs
      .filter((p) => p.maxZoom >= MIN_ZOOM && packCovers(p, lon, lat))
      .sort((a, b) => b.maxZoom - a.maxZoom)[0] ?? null
  );
}

interface WithBox {
  isMesh: boolean;
  geometry: {
    boundingBox: {
      clone(): { applyMatrix4(m: unknown): { min: { y: number } } };
    } | null;
    computeBoundingBox(): void;
  };
}

/** Lowest point of the project's mesh layers in the scene (the street map goes just under it). */
function contentFloor(stage: EngineStage, manifest: ProjectManifest): number | null {
  let min = Infinity;
  for (const l of manifest.layers) {
    if (l.kind !== 'mesh') continue;
    const root = stage.scene.getObjectByName(`layer:${l.id}`);
    if (!root) continue;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as Partial<WithBox>;
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const y = m.geometry.boundingBox?.clone().applyMatrix4(o.matrixWorld).min.y;
      if (y !== undefined && Number.isFinite(y)) min = Math.min(min, y);
    });
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * Draw the street map rings in `stage` while `on` (`shown` of `useStreetMap3d`), for the open
 * project: once the scene is up, nearest ring first. Placed just under the lowest terrain so the
 * yard and its ortho sit on top of it. `probe`: this view looks up which pack covers the site and
 * sizes the rings (the main view); a second view (comparing dates) passes false and reads the
 * main view's answers, so both draw the same ground and opening it does not redraw the main
 * view's.
 */
export function useSiteBasemapLayer(
  stage: EngineStage | null,
  project: { id: string; manifest: ProjectManifest } | null,
  on: boolean,
  probe = true,
): void {
  const wanted = !!project && wantsSiteBasemap(project.manifest);
  const projectId = project?.id ?? null;
  const manifest = project?.manifest ?? null;

  // which projects can have it at all
  useEffect(() => {
    if (!probe) return;
    siteBasemap.getState().setCovered(null);
    if (!wanted || !manifest) return;
    const bridge = (globalThis as { aio?: AioBridge }).aio;
    if (!bridge) return;
    let live = true;
    bridge.invoke('packs:list', {}).then(
      (packs) => {
        if (live) siteBasemap.getState().setCovered(coveringPack(packs, manifest) !== null);
      },
      () => {
        if (live) siteBasemap.getState().setCovered(false);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, manifest, probe]);

  const covered = useSiteBasemap((s) => s.covered);
  const active = !!stage && !!projectId && !!manifest && wanted && on && !!covered;

  // the Low tier (the software renderer) draws smaller pictures
  const sizePx = useGraphics((s) => (s.tier === 'low' ? 1024 : 2048));
  // the floor is read from the newest manifest without redrawing the rings for every change of it
  const manifestNow = useRef(manifest);
  useEffect(() => {
    manifestNow.current = manifest;
  }, [manifest]);

  // what the rings cover: the models, clouds, flights, photos and the origin, measured once the
  // scene is up, and again as data is added (the same rings again change nothing)
  useEffect(() => {
    if (!probe || !active) return;
    let live = true;
    const points = contentPoints(projectId, manifest).catch((): Vec3[] => []);
    const stop = settledBox(
      () => stage.contentBounds(),
      (box) => {
        void points.then((p) => {
          if (!live) return;
          const near = streetMapExtent([...p, ...(box ? boxPoints(box) : [])]);
          siteBasemap.getState().setRings(projectId, JSON.stringify(streetMapRings(near)));
        });
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [probe, active, stage, projectId, manifest]);

  const rings = useSiteBasemap((s) => (s.rings?.projectId === projectId ? s.rings.json : null));

  useEffect(() => {
    if (!active || !rings) return;
    let handle: GroundRingsHandle | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const offs: (() => void)[] = [];
    const layer = {
      kind: 'basemap',
      id: SITE_BASEMAP_ID,
      name: 'Street map',
      visible: true,
      pack: 'auto',
      style: 'dark',
    } as Extract<Layer, { kind: 'basemap' }>;
    const ctx = {
      url: (ref: Parameters<typeof assetUrl>[1]) => assetUrl(projectId, ref),
      scene: stage,
    };
    createStreetRings(layer, ctx, {
      extents: JSON.parse(rings) as GroundExtent[],
      sizePx,
      onRing(mesh, index) {
        if (disposed) return;
        // never pickable: clicks on the street map are clicks on empty ground
        mesh.raycast = () => undefined;
        // projected video lands on the streets
        offs.push(stage.addProjectionReceiver(mesh));
        const group = mesh.parent;
        if (index > 0 || !group) return;
        // it is the ground now, from the first ring on: the plain ground goes
        group.userData.aioGround = true;
        offs.push(stage.addRaycastTarget(group, SITE_BASEMAP_ID));
        // terrain loads in its own time: settle under it as it arrives
        let tries = 0;
        const place = () => {
          const floor = manifestNow.current ? contentFloor(stage, manifestNow.current) : null;
          const y = Math.min(-0.25, (floor ?? 0) - 0.4);
          if (group.position.y !== y + 0.2) {
            // the rings are built at y = -0.2
            group.position.y = y + 0.2;
            group.updateMatrixWorld(true);
            stage.requestRender();
          }
          if (++tries > 20 && timer) clearInterval(timer);
        };
        place();
        timer = setInterval(place, 1500);
      },
    }).then(
      (h) => {
        if (disposed) h.dispose();
        else handle = h;
      },
      (e: unknown) => {
        console.warn('Street map under the site not drawn', e);
      },
    );
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      for (const off of offs) off();
      handle?.dispose();
    };
  }, [active, stage, projectId, rings, sizePx]);
}
