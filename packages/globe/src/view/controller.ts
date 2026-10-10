/**
 * The Globe's scene: the offline CesiumWidget, the Earth of the chosen look (street tiles over
 * the bundled land shapes, imagery packs, or the old Natural Earth raster), terrain from packs,
 * library sites as clustered pins, the open project's issues as pins coloured by severity,
 * picking, hovering, fly-in, the slow idle turn and the camera hand-off. Nothing here edits or
 * measures (decision 3): picking only says what was hit.
 *
 * The scene draws on demand (`requestRenderMode`): every motion here asks for frames only while
 * it runs and then lets the Globe go back to drawing nothing.
 */
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  EllipsoidalOccluder,
  HeadingPitchRange,
  Matrix4,
  Math as CMath,
  Rectangle,
} from '@cesium/core';
import {
  Cesium3DTileset,
  ConstantProperty,
  CustomDataSource,
  EasingFunction,
  EllipsoidTerrainProvider,
  Entity,
  HeightReference,
  ImageryLayer,
  ScreenSpaceEventHandler,
  SceneTransforms,
  ScreenSpaceEventType,
  VerticalOrigin,
  type CesiumWidget,
} from '@cesium/engine';
import type { GlobeSite, RasterPackInfo, TilesetEntry } from '@aio/schema';
import { FetchSource, type Source } from 'pmtiles';
import { siteToGlobe, type GlobeCamera, type SiteCamera } from '../camera';
import { planCredits } from '../credits';
import {
  ecefToGeodetic,
  enuBasis,
  geoidShift,
  localToEcef,
  localToEcefMatrix,
  type SiteGeoref,
} from '../geodesy';
import { planGlobeLayers, type GlobeTileSource, type GlobeTileStats } from '../layers';
import { IDLE_SPIN, WHOLE_EARTH_HEIGHT_M, idleSpinPending, idleSpinRate } from '../look';
import { OFFLINE_CESIUM } from '../offline';
import type { IssuePin } from '../sites';
import {
  DEFAULT_GLOBE_STYLE,
  STREET_GLOBE_PALETTE,
  type GlobePalette,
  type GlobeStyle,
} from '../style';
import { NO_GEOID, type Geoid } from '../terrarium';
import { rasterPackUrl } from '../tiles';
import {
  EarthImageryProvider,
  TileSourceImageryProvider,
  asProvider,
  loadEarthShapes,
} from './earthLayers';
import {
  SITE_PIN_SIZE,
  clusterPin,
  issuePin,
  measurePin,
  sitePin,
  type PinState,
  type PinTone,
} from './pins';
import { PmtilesImageryProvider, asImageryProvider, packTerrainProvider } from './providers';
import {
  configureCesiumBase,
  createOfflineWidget,
  dressScene,
  naturalEarthLayer,
  type GlobeTier,
  type GlobeWidget,
} from './setup';

export type GlobePick =
  { kind: 'site'; projectId: string } | { kind: 'issue'; projectId: string; issueId: string };

/** What the pointer rests on: a site, a cluster of sites, or an issue of the open project. */
export type GlobeHover =
  | { kind: 'site'; projectId: string }
  | { kind: 'cluster'; count: number }
  | { kind: 'issue'; projectId: string; issueId: string };

/** The two labels the view floats over the Globe: beside the selected site, and under the pointer. */
export type GlobeTagSlot = 'selected' | 'hover';

export interface GlobeControllerOptions {
  container: HTMLElement;
  /** The app's copy of Cesium's workers and assets. */
  baseUrl: string;
  tier: GlobeTier;
  /** Jump instead of flying (OS or Settings reduced motion). */
  reducedMotion: () => boolean;
  onPick: (pick: GlobePick | null) => void;
  /** What the pointer rests on, whenever it changes. */
  onHover?: (hover: GlobeHover | null) => void;
  /** The credit lines of what is drawn (the Earth's source, then each pack once). */
  onCredits?: (lines: string[]) => void;
  /** The measuring points (longitude, latitude), whenever they change. */
  onMeasure?: (points: [number, number][]) => void;
  /** Geoid undulation for EGM terrain packs; none bundled yet. */
  geoid?: Geoid;
  /** The look to start with (the street map unless told otherwise). */
  style?: GlobeStyle;
  /** The colours of the street style; the built-in copy of them when left out. */
  palette?: GlobePalette;
  /** The font of the cluster counts (the app's UI font). */
  font?: string;
}

type Pack = RasterPackInfo;
export type SourceFor = (pack: Pick<Pack, 'kind' | 'id'>) => Source;

/** Packs are read from `aio://packs/<kind>/<id>.pmtiles` with range requests. */
export const packSource: SourceFor = (p) => new FetchSource(rasterPackUrl(p.kind, p.id));

const SITE_PREFIX = 'site:';
const ISSUE_PREFIX = 'issue:';
/** Sites closer than this on screen (CSS pixels) gather into a cluster. */
const CLUSTER_REACH_PX = 30;
/** The deepest level the land shapes are painted at, alone and under street tiles. */
const EARTH_LEVELS = { whole: 11, underlay: 8 } as const;

export interface GlobeInspection {
  tilesLoaded: boolean;
  frame: number;
  /** The look drawn, and its layers bottom first. */
  style: GlobeStyle;
  layers: string[];
  imagery: string[];
  imageryTiles: number;
  /** Street tiles drawn so far and what they cost; null when no street pack is drawn. */
  street: GlobeTileStats | null;
  /** The style zoom the street tiles in view agree on (the deepest of them); null before. */
  streetZoom: number | null;
  /** Tiles of the bundled land shapes painted so far, and the milliseconds a tile took (mean). */
  earthTiles: number;
  earthTileMs: number;
  terrain: string[];
  terrainTiles: number;
  sites: string[];
  /** Project tilesets on the Globe and whether their root content is drawn. */
  tilesets: { id: string; ready: boolean }[];
  issuePins: string[];
  credits: string[];
  /** Camera height above the ellipsoid, metres. */
  cameraHeight: number;
  /** A camera flight is under way. */
  flying: boolean;
  /** The idle turn is under way. */
  spinning: boolean;
  /** Device pixels per CSS pixel the scene is drawn at. */
  pixelRatio: number;
  hover: GlobeHover | null;
  selected: string | null;
}

export class GlobeController {
  readonly widget: CesiumWidget;
  private readonly palette: GlobePalette;
  private style: GlobeStyle;
  private street: GlobeTileSource | null = null;
  private imageryPacks: readonly Pack[] = [];
  private terrainPacks: readonly Pack[] = [];
  private sourceFor: SourceFor = packSource;
  private layerNames: string[] = [];
  private layerGeneration = 0;
  private rebuildQueued = false;
  private built: { names: string[]; street: GlobeTileSource | null; sourceFor: SourceFor } | null =
    null;
  private earth: EarthImageryProvider | null = null;
  private streetTiles: { layer: ImageryLayer; provider: TileSourceImageryProvider } | null = null;
  private imageryProviders: PmtilesImageryProvider[] = [];
  private terrainIds: string[] = [];
  private terrainDecoded: (() => number) | null = null;
  private readonly sites = new CustomDataSource('sites');
  private readonly issues = new CustomDataSource('issues');
  private readonly measure = new CustomDataSource('measure');
  private readonly tones = new Map<string, PinTone>();
  private selected: string | null = null;
  private pointerHover: GlobeHover | null = null;
  private pointerAnchor: Cartesian3 | null = null;
  private listHover: string | null = null;
  private readonly tags: Partial<Record<GlobeTagSlot, HTMLElement>> = {};
  private measuring = false;
  private measured: [number, number][] = [];
  private readonly handler: ScreenSpaceEventHandler;
  private credits: string[] = [];
  private tilesets: { id: string; tileset: Cesium3DTileset }[] = [];
  private tilesetGeneration = 0;
  private lastTouch = performance.now();
  private spinTimer: ReturnType<typeof setTimeout> | undefined;
  private spinFrame = 0;
  private spinLast = 0;
  private zoomFrame = 0;
  private hoverFrame = 0;
  private hoverAt: Cartesian2 | null = null;
  private pressed = false;
  private destroyed = false;
  private readonly unlisten: (() => void)[] = [];

  private constructor(
    private readonly g: GlobeWidget,
    private readonly o: GlobeControllerOptions,
  ) {
    this.widget = g.widget;
    this.palette = o.palette ?? STREET_GLOBE_PALETTE;
    this.style = o.style ?? DEFAULT_GLOBE_STYLE;
    const widget = this.widget;
    const font = o.font ?? 'sans-serif';
    const clustering = this.sites.clustering;
    clustering.enabled = true;
    // the sprites carry a wide halo: reach in from their edge, so only dots that touch gather
    clustering.pixelRange = (CLUSTER_REACH_PX - SITE_PIN_SIZE) / 2;
    clustering.minimumClusterSize = 2;
    clustering.clusterEvent.addEventListener((entities, cluster) => {
      const attention = entities.some((e) => this.tones.get(e.id) === 'attention');
      cluster.label.show = false;
      cluster.billboard.show = true;
      // the typings say string; a Billboard takes a canvas as its image as well
      cluster.billboard.image = clusterPin(
        entities.length,
        attention ? 'attention' : 'clear',
        this.palette,
        g.pixelRatio,
        font,
      ) as unknown as string;
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
      cluster.billboard.scale = 1 / g.pixelRatio;
      cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    });
    void widget.dataSources.add(this.sites);
    void widget.dataSources.add(this.issues);
    void widget.dataSources.add(this.measure);
    // a render error stops CesiumJS's render loop: say so in the log (diagnostics, tests)
    widget.scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
      const aura = g.aura?.stage;
      if (aura?.enabled) {
        // a GPU that cannot run the aura pass: go on without it, as the Low preset does
        aura.enabled = false;
        console.warn('The Globe draws without its aura on this GPU:', error);
        widget.useDefaultRenderLoop = true;
        widget.scene.requestRender();
        return;
      }
      console.error('The Globe stopped drawing:', error);
    });
    this.handler = new ScreenSpaceEventHandler(widget.scene.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => {
      this.pick(e.position);
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      this.hoverAt = Cartesian2.clone(e.endPosition, this.hoverAt ?? new Cartesian2());
      if (!this.hoverFrame && !this.pressed)
        this.hoverFrame = requestAnimationFrame(() => {
          this.hoverFrame = 0;
          this.updateHover();
        });
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.listen();
    this.unlisten.push(
      widget.scene.postRender.addEventListener(() => {
        this.placeTags();
      }),
      // pins gather and part when the camera has moved far enough, after the frame that moved
      // it: one more frame shows them (the scene draws on demand)
      widget.scene.camera.changed.addEventListener(() => {
        widget.scene.requestRender();
      }),
      // once the view has come to rest and its tiles are in, the street tiles agree on one style
      widget.scene.camera.moveEnd.addEventListener(() => {
        this.syncStreetStyle();
      }),
      widget.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        if (queued === 0) this.syncStreetStyle();
      }),
    );
    this.rebuildLayers();
    this.armSpin();
  }

  /** Build the Globe in `container`; its Earth follows the look, the packs and the street tiles. */
  static create(o: GlobeControllerOptions): Promise<GlobeController> {
    configureCesiumBase(o.baseUrl);
    const g = createOfflineWidget(o.container, { tier: o.tier }, o.palette ?? STREET_GLOBE_PALETTE);
    return Promise.resolve(new GlobeController(g, o));
  }

  private get scene() {
    return this.widget.scene;
  }

  // ---------------------------------------------------------------- touch, hover, pick

  /** Anything the person does stops the idle turn and starts its wait again. */
  private listen(): void {
    const canvas = this.scene.canvas;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      canvas.addEventListener(type, fn, { passive: true });
      this.unlisten.push(() => {
        canvas.removeEventListener(type, fn);
      });
    };
    on('pointerdown', () => {
      this.pressed = true;
      this.touch();
    });
    // a drag may end anywhere: the release is heard on the window
    const release = () => {
      this.pressed = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    this.unlisten.push(() => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    });
    on('wheel', () => {
      this.touch();
    });
    on('pointerleave', () => {
      this.hoverAt = null;
      this.setPointerHover(null, null);
    });
  }

  private touch(): void {
    this.lastTouch = performance.now();
    this.armSpin();
  }

  private hitAt(position: Cartesian2): { hover: GlobeHover; anchor: Cartesian3 | null } | null {
    const hit = this.scene.pick(position) as
      { id?: unknown; primitive?: { position?: Cartesian3 } } | undefined;
    const id = hit?.id;
    if (Array.isArray(id)) {
      const count = id.filter((e) => e instanceof Entity).length;
      return { hover: { kind: 'cluster', count }, anchor: hit?.primitive?.position ?? null };
    }
    if (!(id instanceof Entity)) return null;
    const anchor = id.position?.getValue(this.widget.clock.currentTime) ?? null;
    if (id.id.startsWith(SITE_PREFIX))
      return { hover: { kind: 'site', projectId: id.id.slice(SITE_PREFIX.length) }, anchor };
    if (id.id.startsWith(ISSUE_PREFIX)) {
      const [projectId = '', issueId = ''] = id.id.slice(ISSUE_PREFIX.length).split('|');
      return { hover: { kind: 'issue', projectId, issueId }, anchor };
    }
    return null;
  }

  private updateHover(): void {
    if (this.destroyed || this.measuring || !this.hoverAt) return;
    const hit = this.hitAt(this.hoverAt);
    this.setPointerHover(hit?.hover ?? null, hit?.anchor ?? null);
  }

  private setPointerHover(hover: GlobeHover | null, anchor: Cartesian3 | null): void {
    const same = JSON.stringify(hover) === JSON.stringify(this.pointerHover);
    this.pointerAnchor = anchor;
    if (same) return;
    const before = this.hoveredSite();
    this.pointerHover = hover;
    this.scene.canvas.style.cursor = hover ? 'pointer' : '';
    this.restyleSites([before, this.hoveredSite()]);
    this.o.onHover?.(hover);
    this.placeTags();
  }

  /** The site that shows as hovered: under the pointer, else the one hovered in the list. */
  private hoveredSite(): string | null {
    return this.pointerHover?.kind === 'site' ? this.pointerHover.projectId : this.listHover;
  }

  /** A site hovered or focused in the list lights its pin as the pointer would. */
  setHighlighted(projectId: string | null): void {
    if (projectId === this.listHover) return;
    const before = this.hoveredSite();
    this.listHover = projectId;
    this.restyleSites([before, this.hoveredSite()]);
    this.placeTags();
  }

  /** The selected site (its card is open): its pin wears the ring and the label stays beside it. */
  setSelected(projectId: string | null): void {
    if (projectId === this.selected) return;
    const before = this.selected;
    this.selected = projectId;
    this.restyleSites([before, projectId]);
    this.placeTags();
    this.armSpin();
  }

  private pinState(projectId: string): PinState {
    if (projectId === this.selected) return 'selected';
    return projectId === this.hoveredSite() ? 'hover' : 'rest';
  }

  private restyleSites(ids: readonly (string | null)[]): void {
    for (const id of new Set(ids)) {
      if (id === null) continue;
      const entity = this.sites.entities.getById(`${SITE_PREFIX}${id}`);
      if (!entity?.billboard) continue;
      const tone = this.tones.get(entity.id) ?? 'clear';
      entity.billboard.image = new ConstantProperty(
        sitePin(tone, this.pinState(id), this.palette, this.g.pixelRatio),
      );
    }
    this.scene.requestRender();
  }

  private pick(position: Cartesian2): void {
    this.touch();
    if (this.measuring) {
      this.addMeasurePoint(position);
      return;
    }
    const hit = this.scene.pick(position) as { id?: unknown } | undefined;
    const id = hit?.id;
    // a cluster: zoom to its sites
    if (Array.isArray(id)) {
      const entities = id.filter((e): e is Entity => e instanceof Entity);
      void this.widget.flyTo(entities, { duration: this.duration(1.6) });
      return;
    }
    if (!(id instanceof Entity)) {
      this.o.onPick(null);
      return;
    }
    if (id.id.startsWith(SITE_PREFIX)) {
      this.o.onPick({ kind: 'site', projectId: id.id.slice(SITE_PREFIX.length) });
    } else if (id.id.startsWith(ISSUE_PREFIX)) {
      const [projectId = '', issueId = ''] = id.id.slice(ISSUE_PREFIX.length).split('|');
      this.o.onPick({ kind: 'issue', projectId, issueId });
    }
  }

  private duration(seconds: number): number {
    return this.o.reducedMotion() ? 0 : seconds;
  }

  // ---------------------------------------------------------------- floating labels

  /**
   * Give the Globe an element to keep beside the selected site or under the pointer (`null`
   * takes it back). The view fills it; the Globe only moves it, after each frame it draws.
   */
  bindTag(slot: GlobeTagSlot, el: HTMLElement | null): void {
    if (el) this.tags[slot] = el;
    else Reflect.deleteProperty(this.tags, slot);
    this.placeTags();
  }

  private sitePosition(projectId: string | null): Cartesian3 | null {
    if (projectId === null) return null;
    const e = this.sites.entities.getById(`${SITE_PREFIX}${projectId}`);
    return e?.position?.getValue(this.widget.clock.currentTime) ?? null;
  }

  private placeTags(): void {
    if (this.destroyed) return;
    const hovered = this.hoveredSite();
    const anchors: Record<GlobeTagSlot, Cartesian3 | null> = {
      selected: this.sitePosition(this.selected),
      // the pointer's own thing first; a site lit from the list has no pointer on the Globe
      hover:
        this.pointerHover && this.pointerHover.kind !== 'site'
          ? this.pointerAnchor
          : hovered !== this.selected
            ? this.sitePosition(hovered)
            : null,
    };
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, this.scene.camera.positionWC);
    for (const slot of ['selected', 'hover'] as const) {
      const el = this.tags[slot];
      if (!el) continue;
      const p = anchors[slot];
      const at =
        p && occluder.isPointVisible(p)
          ? SceneTransforms.worldToWindowCoordinates(this.scene, p)
          : undefined;
      if (!at) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
    }
  }

  // ---------------------------------------------------------------- the Earth: layers and terrain

  /** The look: the street map (default), imagery packs over it, or the old Natural Earth raster. */
  setStyle(style: GlobeStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.queueRebuild();
  }

  /** The host's street tiles (null: no street pack is installed). The Globe never disposes them. */
  setStreet(source: GlobeTileSource | null): void {
    if (source === this.street) return;
    this.street = source;
    this.queueRebuild();
  }

  /**
   * The imagery packs the Imagery setting selects (drawn in the Satellite and Natural Earth
   * looks, least detailed lowest) and the terrain packs as one terrain (none on the Low preset).
   */
  setPacks(imagery: readonly Pack[], terrain: readonly Pack[], sourceFor: SourceFor = packSource) {
    this.imageryPacks = imagery;
    this.terrainPacks = terrain;
    this.sourceFor = sourceFor;
    this.applyTerrain();
    this.queueRebuild();
  }

  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    queueMicrotask(() => {
      this.rebuildQueued = false;
      if (!this.destroyed) this.rebuildLayers();
    });
  }

  private applyTerrain(): void {
    const terrain = this.terrainPacks;
    const useTerrain = this.o.tier !== 'low' && terrain.length > 0;
    if (useTerrain) {
      const provider = packTerrainProvider({
        packs: terrain,
        sourceFor: this.sourceFor,
        geoid: this.o.geoid ?? NO_GEOID,
        size: this.o.tier === 'medium' ? 33 : 65,
      });
      this.terrainDecoded = provider.tilesDecoded;
      this.scene.terrainProvider = provider;
      this.terrainIds = terrain.map((p) => p.id);
    } else {
      this.scene.terrainProvider = new EllipsoidTerrainProvider();
      this.terrainDecoded = null;
      this.terrainIds = [];
    }
  }

  /**
   * Build the imagery layers of the plan (`planGlobeLayers`) in place of what was there; a plan
   * that lists what is already drawn only refreshes the credits.
   */
  private rebuildLayers(): void {
    const { look, pixelRatio } = this.g;
    const street = this.street;
    const plan = planGlobeLayers({
      style: this.style,
      street: street !== null,
      imagery: this.imageryPacks,
    });
    const names = plan.map((entry) =>
      entry.kind === 'earth-shapes'
        ? `earth-shapes:${entry.role}`
        : entry.kind === 'imagery-pack'
          ? `pack:${entry.pack.id}`
          : entry.kind === 'natural-earth'
            ? OFFLINE_CESIUM.naturalEarth
            : entry.kind,
    );
    const built = this.built;
    const same =
      built !== null &&
      built.street === street &&
      built.sourceFor === this.sourceFor &&
      built.names.join('|') === names.join('|');
    if (!same) {
      const generation = ++this.layerGeneration;
      const layers = this.scene.imageryLayers;
      layers.removeAll(true);
      this.imageryProviders = [];
      this.earth = null;
      this.streetTiles = null;
      for (const entry of plan) {
        if (entry.kind === 'earth-shapes') {
          const imagePx = Math.round((entry.role === 'whole' ? 512 : 256) * pixelRatio);
          const ink = this.palette;
          const maximumLevel = EARTH_LEVELS[entry.role];
          layers.add(
            ImageryLayer.fromProviderAsync(
              loadEarthShapes().then((shapes) => {
                const provider = new EarthImageryProvider(shapes, {
                  ink,
                  imagePx,
                  pixelRatio,
                  maximumLevel,
                });
                if (generation === this.layerGeneration) this.earth = provider;
                return asProvider(provider);
              }),
            ),
          );
        } else if (entry.kind === 'street') {
          if (street) {
            const provider = new TileSourceImageryProvider(street, pixelRatio);
            const layer = new ImageryLayer(asProvider(provider));
            layers.add(layer);
            this.streetTiles = { layer, provider };
          }
        } else if (entry.kind === 'natural-earth') {
          layers.add(naturalEarthLayer());
        } else {
          const provider = new PmtilesImageryProvider(entry.pack, this.sourceFor(entry.pack));
          this.imageryProviders.push(provider);
          layers.add(new ImageryLayer(asImageryProvider(provider)));
        }
      }
      this.built = { names, street, sourceFor: this.sourceFor };
      this.layerNames = names;
      this.scene.globe.maximumScreenSpaceError = names.includes('street')
        ? look.streetScreenSpaceError
        : look.screenSpaceError;
      dressScene(this.g, this.style, this.palette);
    }
    const terrainInUse = this.terrainPacks.filter((p) => this.terrainIds.includes(p.id));
    this.credits = planCredits(plan, street?.credit ?? '', terrainInUse);
    this.o.onCredits?.(this.credits);
    this.scene.requestRender();
  }

  /**
   * Street tiles are drawn per tile, each in the style of its own zoom, so where a coarser tile
   * meets a finer one a label would change size and be cut at the edge. With the view at rest,
   * every street tile in view is drawn again in the style of the deepest one (`syncView`).
   */
  private syncStreetStyle(): void {
    const street = this.streetTiles;
    if (!street || this.destroyed || this.flying()) return;
    // CesiumJS's list of the tiles it draws, each with the imagery it wants per layer
    interface DrawnImagery {
      imageryLayer?: unknown;
      level: number;
      x: number;
      y: number;
    }
    interface DrawnTile {
      data?: { imagery?: { loadingImagery?: DrawnImagery; readyImagery?: DrawnImagery }[] };
    }
    const surface = (this.scene.globe as unknown as { _surface?: { _tilesToRender?: DrawnTile[] } })
      ._surface;
    const inView: { level: number; x: number; y: number }[] = [];
    for (const tile of surface?._tilesToRender ?? []) {
      for (const slot of tile.data?.imagery ?? []) {
        const wanted = slot.loadingImagery ?? slot.readyImagery;
        if (wanted?.imageryLayer === street.layer)
          inView.push({ level: wanted.level, x: wanted.x, y: wanted.y });
      }
    }
    if (street.provider.syncView(inView)) this.scene.requestRender();
  }

  // ---------------------------------------------------------------- measuring

  /**
   * The geodesic read-out (decision 3, the Globe's only tool): while on, clicks put points on the
   * ground instead of picking; the caller words the distance and area "on the ellipsoid".
   */
  setMeasuring(on: boolean): void {
    this.measuring = on;
    if (on) this.setPointerHover(null, null);
    else {
      this.measured = [];
      this.drawMeasure();
    }
    this.armSpin();
  }

  private addMeasurePoint(position: Cartesian2): void {
    const ray = this.scene.camera.getPickRay(position);
    const hit = ray
      ? (this.scene.globe.pick(ray, this.scene) ?? this.scene.camera.pickEllipsoid(position))
      : undefined;
    if (!hit) return;
    const c = Cartographic.fromCartesian(hit);
    this.measured = [...this.measured, [CMath.toDegrees(c.longitude), CMath.toDegrees(c.latitude)]];
    this.drawMeasure();
  }

  private drawMeasure(): void {
    const pts = this.measured;
    this.measure.entities.removeAll();
    const ring = pts.length >= 3 ? [...pts, pts[0] ?? [0, 0]] : pts;
    if (ring.length >= 2)
      this.measure.entities.add({
        polyline: {
          positions: Cartesian3.fromDegreesArray(ring.flat()),
          clampToGround: true,
          width: 2.5,
          material: Color.fromCssColorString(this.palette.ink),
        },
      });
    for (const [lon, lat] of pts)
      this.measure.entities.add({
        position: Cartesian3.fromDegrees(lon, lat),
        billboard: {
          image: measurePin(this.palette, this.g.pixelRatio),
          // sprites are drawn in device pixels; CesiumJS sizes billboards in CSS pixels
          scale: 1 / this.g.pixelRatio,
          verticalOrigin: VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    this.o.onMeasure?.(pts.map((p) => [p[0], p[1]]));
    this.scene.requestRender();
  }

  /** Vertical exaggeration of the terrain (Globe settings). */
  setExaggeration(k: number): void {
    this.scene.verticalExaggeration = k;
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- pins

  /** Library projects as pins at their origins, clustered when they crowd. */
  setSites(sites: readonly GlobeSite[]): void {
    this.sites.entities.suspendEvents();
    this.sites.entities.removeAll();
    this.tones.clear();
    for (const s of sites) {
      const id = `${SITE_PREFIX}${s.projectId}`;
      const tone: PinTone = s.issues.open > 0 ? 'attention' : 'clear';
      this.tones.set(id, tone);
      this.sites.entities.add({
        id,
        name: s.name,
        position: Cartesian3.fromDegrees(s.lonLat[0], s.lonLat[1], 0),
        billboard: {
          image: sitePin(tone, this.pinState(s.projectId), this.palette, this.g.pixelRatio),
          // sprites are drawn in device pixels; CesiumJS sizes billboards in CSS pixels
          scale: 1 / this.g.pixelRatio,
          verticalOrigin: VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.sites.entities.resumeEvents();
    this.scene.requestRender();
  }

  /** The open project's issues as pins at their 3D anchors, coloured by severity. */
  setIssuePins(projectId: string, georef: SiteGeoref, pins: readonly IssuePin[]): void {
    this.issues.entities.suspendEvents();
    this.issues.entities.removeAll();
    for (const p of pins) {
      const [x, y, z] = localToEcef(p.local, georef);
      this.issues.entities.add({
        id: `${ISSUE_PREFIX}${projectId}|${p.id}`,
        name: `${p.code} ${p.title}`,
        position: new Cartesian3(x, y, z),
        billboard: {
          image: issuePin(p.colour, this.palette, this.g.pixelRatio),
          // sprites are drawn in device pixels; CesiumJS sizes billboards in CSS pixels
          scale: 1 / this.g.pixelRatio,
          verticalOrigin: VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.issues.entities.resumeEvents();
    this.scene.requestRender();
  }

  /**
   * The open project's 3D Tiles (`tilesets.json`, data-conventions section 22), read from the
   * project over `aio://project/<id>/<src>`. Ours are written in ECEF; an imported tileset's
   * `transform` places it in the project frame, which the site's frame takes to ECEF.
   */
  async setTilesets(
    projectId: string,
    georef: SiteGeoref,
    entries: readonly Pick<TilesetEntry, 'id' | 'src' | 'visible' | 'transform'>[],
  ): Promise<void> {
    const generation = ++this.tilesetGeneration;
    for (const t of this.tilesets) this.scene.primitives.remove(t.tileset);
    this.tilesets = [];
    const frame = Matrix4.fromArray(localToEcefMatrix(georef));
    for (const e of entries) {
      if (!e.visible) continue;
      const path = e.src.split('/').map(encodeURIComponent).join('/');
      try {
        const tileset = await Cesium3DTileset.fromUrl(
          `aio://project/${encodeURIComponent(projectId)}/${path}`,
          {
            maximumScreenSpaceError: this.o.tier === 'low' ? 32 : 16,
            cacheBytes: OFFLINE_CESIUM.tileCacheBytes,
            maximumCacheOverflowBytes: OFFLINE_CESIUM.tileCacheBytes / 2,
          },
        );
        if (generation !== this.tilesetGeneration || this.widget.isDestroyed()) {
          tileset.destroy();
          return;
        }
        if (e.transform)
          tileset.modelMatrix = Matrix4.multiply(
            frame,
            Matrix4.fromArray(e.transform),
            new Matrix4(),
          );
        const shift = geoidShift(tileset.extras, this.o.geoid ?? NO_GEOID);
        if (shift)
          tileset.modelMatrix = Matrix4.multiply(
            Matrix4.fromTranslation(new Cartesian3(...shift)),
            tileset.modelMatrix,
            new Matrix4(),
          );
        this.scene.primitives.add(tileset);
        this.tilesets.push({ id: e.id, tileset });
      } catch (err) {
        console.warn(`The Globe could not load tileset ${e.id}:`, err);
      }
    }
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- camera

  /** The whole Earth, or a box around the given sites. */
  flyHome(bounds: readonly [number, number, number, number] | null): void {
    this.touch();
    const rect = bounds
      ? Rectangle.fromDegrees(...bounds)
      : Rectangle.fromDegrees(-30, -40, 110, 70);
    this.scene.camera.flyTo({
      destination: rect,
      duration: this.duration(1.8),
      easingFunction: EasingFunction.QUINTIC_IN_OUT,
    });
  }

  /** Fly to a site: looking down at 45 degrees from the south, `range` metres away. */
  flyToSite(lonLat: readonly [number, number], range = 1500): Promise<void> {
    this.touch();
    const centre = Cartesian3.fromDegrees(lonLat[0], lonLat[1], 0);
    return new Promise((resolve) => {
      this.scene.camera.flyToBoundingSphere(new BoundingSphere(centre, 50), {
        offset: new HeadingPitchRange(0, CMath.toRadians(-45), range),
        duration: this.duration(2.4),
        // a gentle start and a soft landing, whatever the distance
        easingFunction: EasingFunction.QUARTIC_IN_OUT,
        complete: resolve,
        cancel: resolve,
      });
    });
  }

  /**
   * Step the view towards (`in`) or away from (`out`) what is in the middle of it, by half the
   * distance (or twice): a short eased move, a jump with reduced motion.
   */
  zoom(direction: 'in' | 'out'): void {
    this.touch();
    const scene = this.scene;
    const camera = scene.camera;
    cancelAnimationFrame(this.zoomFrame);
    const canvas = scene.canvas;
    const centre = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const target = camera.pickEllipsoid(centre);
    const range = target
      ? Cartesian3.distance(camera.positionWC, target)
      : camera.positionCartographic.height;
    const control = scene.screenSpaceCameraController;
    const wanted =
      direction === 'in'
        ? Math.max(range / 2, control.minimumZoomDistance * 4)
        : Math.min(range * 2, control.maximumZoomDistance);
    const total = range - wanted;
    if (Math.abs(total) < 1) return;
    const ms = this.duration(0.28) * 1000;
    if (ms === 0) {
      camera.moveForward(total);
      scene.requestRender();
      return;
    }
    const t0 = performance.now();
    let done = 0;
    const step = (now: number) => {
      if (this.destroyed) return;
      const t = Math.min(1, (now - t0) / ms);
      // ease-out: most of the way at once, then it settles
      const eased = 1 - (1 - t) ** 3;
      camera.moveForward(total * eased - done);
      done = total * eased;
      scene.requestRender();
      if (t < 1) this.zoomFrame = requestAnimationFrame(step);
    };
    this.zoomFrame = requestAnimationFrame(step);
  }

  /** The camera as the hand-off needs it (ECEF position and direction). */
  camera(): GlobeCamera {
    const c = this.scene.camera;
    return {
      position: [c.positionWC.x, c.positionWC.y, c.positionWC.z],
      direction: [c.directionWC.x, c.directionWC.y, c.directionWC.z],
    };
  }

  /** Put the camera where a site view camera was (**Back to globe**). */
  setSiteCamera(cam: SiteCamera, georef: SiteGeoref): void {
    this.setCamera(siteToGlobe(cam, georef));
  }

  setCamera(cam: GlobeCamera): void {
    this.touch();
    const [lon, lat] = ecefToGeodetic(...cam.position);
    const { u } = enuBasis(lon, lat);
    const d = cam.direction;
    const k = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
    const up = new Cartesian3(u[0] - k * d[0], u[1] - k * d[1], u[2] - k * d[2]);
    Cartesian3.normalize(up, up);
    this.scene.camera.setView({
      destination: new Cartesian3(...cam.position),
      orientation: { direction: new Cartesian3(...d), up },
    });
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- the idle turn

  private flying(): boolean {
    const camera = this.scene.camera as unknown as { _currentFlight?: unknown };
    return camera._currentFlight !== undefined;
  }

  /** Whether the slow turn may run: the whole Earth in view, nothing selected, nobody busy. */
  private maySpin(): boolean {
    return (
      this.g.look.idleSpin &&
      !this.destroyed &&
      !this.measuring &&
      this.selected === null &&
      !this.pressed &&
      !this.o.reducedMotion() &&
      !document.hidden &&
      !this.flying() &&
      this.scene.camera.positionCartographic.height >= WHOLE_EARTH_HEIGHT_M
    );
  }

  /** Stop the turn and wait again: it starts after a quiet spell and rests after a while. */
  private armSpin(): void {
    clearTimeout(this.spinTimer);
    cancelAnimationFrame(this.spinFrame);
    this.spinFrame = 0;
    if (!this.g.look.idleSpin || this.destroyed) return;
    this.spinTimer = setTimeout(() => {
      if (!this.maySpin()) return;
      this.spinLast = performance.now();
      this.spinFrame = requestAnimationFrame(this.spin);
    }, IDLE_SPIN.delayMs);
  }

  private readonly spin = (now: number): void => {
    this.spinFrame = 0;
    const since = now - this.lastTouch;
    if (!idleSpinPending(since) || !this.maySpin()) return;
    const dt = Math.min(100, now - this.spinLast) / 1000;
    this.spinLast = now;
    const rate = idleSpinRate(since);
    if (rate > 0) {
      // the camera goes west, so the Earth turns east under it, as it does
      this.scene.camera.rotate(Cartesian3.UNIT_Z, CMath.toRadians(rate * dt));
      this.scene.requestRender();
    }
    this.spinFrame = requestAnimationFrame(this.spin);
  };

  // ---------------------------------------------------------------- inspection

  /**
   * Where a site or issue pin is drawn, in CSS pixels of the canvas (`site:<projectId>` or
   * `issue:<projectId>|<issueId>`); null when it is not on screen.
   */
  pinPosition(id: string): [number, number] | null {
    const e = this.sites.entities.getById(id) ?? this.issues.entities.getById(id);
    const p = e?.position?.getValue(this.widget.clock.currentTime);
    if (!p) return null;
    const w = SceneTransforms.worldToWindowCoordinates(this.scene, p);
    return w ? [w.x, w.y] : null;
  }

  /** What the Globe shows now (the inspection hook of the e2e tests and diagnostics). */
  inspect(): GlobeInspection {
    const scene = this.scene;
    return {
      tilesLoaded: scene.globe.tilesLoaded,
      frame: (scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber,
      style: this.style,
      layers: [...this.layerNames],
      imagery: this.imageryProviders.map((p) => p.pack.id),
      imageryTiles: this.imageryProviders.reduce((n, p) => n + p.tilesLoaded, 0),
      street: this.layerNames.includes('street') ? (this.street?.stats?.() ?? null) : null,
      streetZoom: this.streetTiles?.provider.viewZoom ?? null,
      earthTiles: this.earth?.tilesDrawn ?? 0,
      earthTileMs: this.earth?.tilesDrawn ? this.earth.drawMs / this.earth.tilesDrawn : 0,
      terrain: this.terrainIds,
      terrainTiles: this.terrainDecoded?.() ?? 0,
      sites: this.sites.entities.values.map((e) => e.id.slice(SITE_PREFIX.length)),
      tilesets: this.tilesets.map(({ id, tileset }) => ({
        id,
        ready:
          tileset.tilesLoaded && (tileset.root as { contentReady?: boolean }).contentReady === true,
      })),
      issuePins: this.issues.entities.values.map((e) => e.id.slice(ISSUE_PREFIX.length)),
      credits: this.credits,
      cameraHeight: scene.camera.positionCartographic.height,
      flying: this.flying(),
      spinning: this.spinFrame !== 0,
      pixelRatio: this.g.pixelRatio,
      hover: this.pointerHover,
      selected: this.selected,
    };
  }

  /** The colour drawn at a point of the canvas (fractions of its size), after the next frame. */
  samplePixel(fx: number, fy: number): Promise<[number, number, number, number]> {
    const scene = this.scene;
    return new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl;
        const x = Math.round(fx * (gl.drawingBufferWidth - 1));
        const y = Math.round((1 - fy) * (gl.drawingBufferHeight - 1));
        const px = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        resolve([px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0]);
      });
      scene.requestRender();
    });
  }

  /** Height of the terrain under a point (most detailed level loaded), metres above the ellipsoid. */
  terrainHeight(lon: number, lat: number): number | undefined {
    return this.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
  }

  /** Tear the scene down and give its WebGL context back (the Globe owns the GPU only while open). */
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.spinTimer);
    cancelAnimationFrame(this.spinFrame);
    cancelAnimationFrame(this.zoomFrame);
    cancelAnimationFrame(this.hoverFrame);
    for (const off of this.unlisten) off();
    const canvas = this.scene.canvas;
    this.handler.destroy();
    this.widget.destroy();
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
