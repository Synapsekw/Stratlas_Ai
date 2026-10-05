/**
 * The offline street map under the site in 3D: the maps package's `basemap` ground (the app's
 * street style rendered from the installed PMTiles packs and draped as a ground quad around the
 * project origin), added for projects whose manifest has no basemap layer of its own. On by
 * default for stockpile projects, a choice remembered per project otherwise (Layers popover).
 * Nothing is drawn, and nothing fails, when no installed pack covers the site.
 */
import { getAdapter, type EngineStage, type LayerHandle } from '@aio/engine';
import { frameProjection, packCovers } from '@aio/maps';
import type { AioBridge, Layer, MapPackInfo, ProjectManifest } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { useEffect } from 'react';
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

/** A project placed on the Earth with ground imagery or stockpiles and no basemap layer. */
export function wantsSiteBasemap(manifest: ProjectManifest): boolean {
  if (!('epsg' in manifest.crs)) return false;
  if (manifest.layers.some((l) => l.kind === 'basemap')) return false;
  return manifest.layers.some((l) => l.kind === 'raster' && l.role === 'ortho');
}

/** On unless switched off; projects without stockpiles start off (their own maps come first). */
export function siteBasemapOn(
  choices: Record<string, boolean>,
  projectId: string,
  volumetric: boolean,
): boolean {
  return choices[projectId] ?? volumetric;
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
  useEffect(() => {
    if (!stage || !projectId || !manifest || !wanted || !on || !covered) return;
    const adapter = getAdapter('basemap');
    if (!adapter) return;
    let handle: LayerHandle | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const layer = {
      kind: 'basemap',
      id: SITE_BASEMAP_ID,
      name: 'Street map',
      visible: true,
      pack: 'auto',
      style: 'dark',
    } as Layer;
    adapter.create(layer, { url: (ref) => assetUrl(projectId, ref), scene: stage }).then(
      (h) => {
        if (disposed) {
          h.dispose();
          return;
        }
        handle = h;
        const mesh = stage.scene.getObjectByName(`basemap:${SITE_BASEMAP_ID}`);
        if (!mesh) return;
        // never pickable: clicks on the street map are clicks on empty ground
        mesh.raycast = () => undefined;
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
      handle?.dispose();
    };
  }, [stage, projectId, manifest, wanted, on, covered]);
}
