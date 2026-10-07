/**
 * The offline street map under the site in 3D: the maps package's street ground (the app's
 * street style rendered from the installed PMTiles packs and draped as a ground quad), added for
 * projects placed on the Earth whose manifest has no basemap layer of its own. It covers what the
 * project covers (flight paths, photo places, the origin) and stands in for the plain ground, so
 * a project that starts with drone video is placed on the map at once. On by default for
 * stockpile projects and projects without their own ground (no ortho, model or cloud), a choice
 * remembered per project otherwise (Layers popover). Nothing is drawn, and nothing fails, when no
 * installed pack covers the site.
 */
import type { EngineStage, LayerHandle } from '@aio/engine';
import { createStreetGround, frameProjection, packCovers, type GroundExtent } from '@aio/maps';
import type { AioBridge, Layer, MapPackInfo, ProjectManifest, Vec3 } from '@aio/schema';
import { loadFlight } from '@aio/video';
import { assetUrl } from '@aio/workspace';
import type { Mesh } from 'three';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

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
  /** Choices made per project (absent: the project's default). */
  choices: Record<string, boolean>;
  /** The open project has a covering pack: null while unknown. */
  covered: boolean | null;
  set(projectId: string, on: boolean): void;
  setCovered(covered: boolean | null): void;
}

export const siteBasemap = createStore<SiteBasemapState>()((set, get) => ({
  choices: readChoices(),
  covered: null,
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
}));

export function useSiteBasemap<T>(selector: (s: SiteBasemapState) => T): T {
  return useStore(siteBasemap, selector);
}

/** A project placed on the Earth (a projected CRS) with no basemap layer of its own. */
export function wantsSiteBasemap(manifest: ProjectManifest): boolean {
  if (!('epsg' in manifest.crs)) return false;
  return !manifest.layers.some((l) => l.kind === 'basemap');
}

/** The project brings its own ground or model: an ortho, a mesh or a point cloud. */
export function hasOwnGround(manifest: ProjectManifest): boolean {
  return manifest.layers.some(
    (l) =>
      l.kind === 'mesh' || l.kind === 'pointcloud' || (l.kind === 'raster' && l.role === 'ortho'),
  );
}

/**
 * The street map starts on for stockpile projects and for projects without their own ground
 * (video and photos first); off where the project's own maps and models come first.
 */
export function siteBasemapDefault(manifest: ProjectManifest, volumetric: boolean): boolean {
  return volumetric || !hasOwnGround(manifest);
}

/** The remembered choice, else the project's default (`siteBasemapDefault`). */
export function siteBasemapOn(
  choices: Record<string, boolean>,
  projectId: string,
  defaultOn: boolean,
): boolean {
  return choices[projectId] ?? defaultOn;
}

/** Street map margin around the content, and its smallest and largest half size, metres. */
const MARGIN = 1.25;
const PAD_M = 150;
const MIN_HALF_M = 400;
const MAX_HALF_M = 6000;
/** The square the street map covered before it followed the content (models, orthos). */
const LEGACY_HALF_M = 2500;

/**
 * The square of the local frame the street map covers: the content (flight paths, photo places)
 * and the origin with a margin, at least MIN_HALF_M (or the old 5 km square when the project
 * has its own ground or models, which are not measured here), at most MAX_HALF_M. Rounded to
 * 50 m so small additions do not redraw it.
 */
export function streetMapExtent(points: readonly Vec3[], ownGround = false): GroundExtent {
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
    Math.max(
      ownGround ? LEGACY_HALF_M : MIN_HALF_M,
      Math.ceil((span * MARGIN + PAD_M) / step) * step,
    ),
  );
  return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
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
 * Draw the street map ground in `stage` while `on`, for the open project. Placed just under the
 * lowest terrain so the yard and its ortho sit on top of it. `probe`: this view looks up which
 * pack covers the site (the main view); a second view (comparing dates) passes false and reads
 * the main view's answer, so opening it does not redraw the main view's street map.
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

  // what the street map covers: the flights, photos and origin, recomputed as data is added
  const [extent, setExtent] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const own = hasOwnGround(manifest);
    contentPoints(projectId, manifest).then(
      (points) => {
        if (live) setExtent(JSON.stringify(streetMapExtent(points, own)));
      },
      () => {
        if (live) setExtent(JSON.stringify(streetMapExtent([], own)));
      },
    );
    return () => {
      live = false;
    };
  }, [active, projectId, manifest]);

  useEffect(() => {
    if (!active || !extent) return;
    let handle: LayerHandle | null = null;
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
    createStreetGround(layer, ctx, JSON.parse(extent) as GroundExtent).then(
      (h) => {
        if (disposed) {
          h.dispose();
          return;
        }
        handle = h;
        const mesh = stage.scene.getObjectByName(`basemap:${SITE_BASEMAP_ID}`) as Mesh | undefined;
        if (!mesh) return;
        // never pickable: clicks on the street map are clicks on empty ground
        mesh.raycast = () => undefined;
        // it is the ground now: the plain ground goes, projected video lands on the streets
        mesh.userData.aioGround = true;
        offs.push(stage.addRaycastTarget(mesh, SITE_BASEMAP_ID), stage.addProjectionReceiver(mesh));
        // terrain loads in its own time: settle under it as it arrives
        let tries = 0;
        const place = () => {
          const floor = contentFloor(stage, manifest);
          const y = Math.min(-0.25, (floor ?? 0) - 0.4);
          if (mesh.position.y !== y + 0.2) {
            // the ground quad is built at y = -0.2
            mesh.position.y = y + 0.2;
            mesh.updateMatrixWorld(true);
            stage.requestRender();
          }
          if (++tries > 20 && timer) clearInterval(timer);
        };
        place();
        timer = setInterval(place, 1500);
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
  }, [active, stage, projectId, manifest, extent]);
}
