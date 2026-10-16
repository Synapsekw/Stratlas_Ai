/**
 * The processed outputs of the sites in focus on the Globe: each project's 3D Tiles and its shown
 * kit-pyramid rasters, kept by project and layer id so that a change touches only what changed
 * (switching a heat map on adds one imagery layer; another site in focus leaves the first one's
 * tilesets and layers as they are). The scene is reached through a host, so this holds no
 * CesiumJS of its own: the controller is the host.
 */
import type { DateShift, TilesetEntry } from '@aio/schema';
import type { SiteGeoref } from '../geodesy';
import type { PyramidIndex } from '../projectRasters';

/** A shown raster of a site: its layer, its `tiles.json` and the index read from it. */
export interface SiteOutputRaster {
  layerId: string;
  src: string;
  index: PyramidIndex;
  /** The date shift of the raster's layer, metres east and north; absent for none. */
  shift?: DateShift;
}

/** A shift as a comparison key, to the millimetre; empty for none. */
const shiftKeyOf = (s: DateShift | undefined): string =>
  s ? `${Math.round(s.eastM * 1000)},${Math.round(s.northM * 1000)}` : '';

/** What one site in focus draws on the Globe. */
export interface SiteOutputs {
  projectId: string;
  georef: SiteGeoref;
  tilesets: readonly Pick<TilesetEntry, 'id' | 'src' | 'visible' | 'transform'>[];
  /** Shown rasters, bottom first (`rasterOrder`). */
  rasters: readonly SiteOutputRaster[];
}

/** A raster on the Globe, as the layer plan lists it. */
export interface SiteRasterRef {
  projectId: string;
  layerId: string;
}

/** The scene the outputs are drawn in: tilesets `T`, imagery layers `L`, raster providers `P`. */
export interface SiteOutputHost<T, L, P> {
  /** Load a site's shown tilesets; when `current()` turns false meanwhile, give back none. */
  loadTilesets(site: SiteOutputs, current: () => boolean): Promise<T[]>;
  removeTileset(tileset: T): void;
  createProvider(site: SiteOutputs, raster: SiteOutputRaster): P;
  disposeProvider(provider: P): void;
  /** A new imagery layer of the provider, added on top. */
  addLayer(provider: P): L;
  removeLayer(layer: L): void;
  raiseToTop(layer: L): void;
}

interface RasterState<L, P> {
  src: string;
  shiftKey: string;
  layer: L;
  provider: P;
}

interface ProjectState<T, L, P> {
  georefKey: string;
  tilesetsKey: string;
  generation: number;
  tilesets: T[];
  rasters: Map<string, RasterState<L, P>>;
  /** Shown layer ids, bottom first. */
  order: string[];
}

export class SiteOutputLayers<T, L, P> {
  private readonly projects = new Map<string, ProjectState<T, L, P>>();
  /** After `dispose` the scene is gone: late tilesets are not handed back to it. */
  private disposed = false;
  /** Project ids, in the order given. */
  private projectOrder: string[] = [];

  constructor(private readonly host: SiteOutputHost<T, L, P>) {}

  /**
   * Draw these sites' outputs: sites no longer listed lose their tilesets, layers and providers;
   * a new site, or one whose tilesets changed, has its tilesets loaded; rasters are added and
   * dropped by layer id; then the shown rasters are raised to the top, bottom first. Resolves
   * once the tilesets this call started loading are in; it does not wait for a load an earlier
   * call started for the same tilesets.
   */
  async set(outputs: readonly SiteOutputs[]): Promise<void> {
    const wanted = new Set(outputs.map((o) => o.projectId));
    for (const id of [...this.projects.keys()]) if (!wanted.has(id)) this.drop(id);
    const loads: Promise<void>[] = [];
    for (const site of outputs) {
      const georefKey = JSON.stringify(site.georef);
      const tilesetsKey = JSON.stringify(site.tilesets);
      let state = this.projects.get(site.projectId);
      // another frame places everything elsewhere: start the site again
      if (state && state.georefKey !== georefKey) {
        this.drop(site.projectId);
        state = undefined;
      }
      if (!state) {
        state = {
          georefKey,
          tilesetsKey: '',
          generation: 0,
          tilesets: [],
          rasters: new Map(),
          order: [],
        };
        this.projects.set(site.projectId, state);
      }
      if (state.tilesetsKey !== tilesetsKey) {
        state.tilesetsKey = tilesetsKey;
        loads.push(this.loadTilesets(site, state));
      }
      const shown = new Map(site.rasters.map((r) => [r.layerId, r]));
      for (const [layerId, r] of state.rasters) {
        const now = shown.get(layerId);
        // another place (a date lined up, or taken back) is a new provider
        if (now?.src === r.src && shiftKeyOf(now.shift) === r.shiftKey) continue;
        this.host.removeLayer(r.layer);
        this.host.disposeProvider(r.provider);
        state.rasters.delete(layerId);
      }
      for (const raster of site.rasters) {
        if (state.rasters.has(raster.layerId)) continue;
        const provider = this.host.createProvider(site, raster);
        state.rasters.set(raster.layerId, {
          src: raster.src,
          shiftKey: shiftKeyOf(raster.shift),
          provider,
          layer: this.host.addLayer(provider),
        });
      }
      state.order = site.rasters.map((r) => r.layerId);
    }
    this.projectOrder = outputs.map((o) => o.projectId);
    for (const { layer } of this.rasters()) this.host.raiseToTop(layer);
    await Promise.all(loads);
  }

  private async loadTilesets(site: SiteOutputs, state: ProjectState<T, L, P>): Promise<void> {
    for (const t of state.tilesets) this.host.removeTileset(t);
    state.tilesets = [];
    const generation = ++state.generation;
    const current = () =>
      this.projects.get(site.projectId) === state && state.generation === generation;
    const loaded = await this.host.loadTilesets(site, current);
    if (current()) state.tilesets = loaded;
    else if (!this.disposed) for (const t of loaded) this.host.removeTileset(t);
  }

  private drop(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.projects.delete(projectId);
    state.generation++;
    for (const t of state.tilesets) this.host.removeTileset(t);
    for (const r of state.rasters.values()) {
      this.host.removeLayer(r.layer);
      this.host.disposeProvider(r.provider);
    }
  }

  /**
   * The base layers were built anew (and the old layers destroyed with them): a new layer of
   * this raster's provider goes on top. The controller calls it for each `project-raster` entry
   * of its plan, in order.
   */
  readd(ref: SiteRasterRef): void {
    const r = this.projects.get(ref.projectId)?.rasters.get(ref.layerId);
    if (r) r.layer = this.host.addLayer(r.provider);
  }

  /** The shown rasters, bottom first, as the layer plan takes them. */
  order(): SiteRasterRef[] {
    return this.rasters().map(({ projectId, layerId }) => ({ projectId, layerId }));
  }

  /** The shown rasters, bottom first, with their layers and providers. */
  rasters(): (SiteRasterRef & { layer: L; provider: P })[] {
    return this.projectOrder.flatMap((projectId) => {
      const state = this.projects.get(projectId);
      if (!state) return [];
      return state.order.flatMap((layerId) => {
        const r = state.rasters.get(layerId);
        return r ? [{ projectId, layerId, layer: r.layer, provider: r.provider }] : [];
      });
    });
  }

  /** The tilesets drawn now, by project. */
  tilesets(): { projectId: string; tileset: T }[] {
    return this.projectOrder.flatMap((projectId) =>
      (this.projects.get(projectId)?.tilesets ?? []).map((tileset) => ({ projectId, tileset })),
    );
  }

  /** Remove everything and dispose every provider (leaving the Globe). */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.projects.keys()]) this.drop(id);
    this.projectOrder = [];
  }
}
