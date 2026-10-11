/**
 * The Globe's scene: the offline CesiumWidget, the Earth of the chosen look (street tiles over
 * the bundled land shapes, imagery packs, or the old Natural Earth raster), terrain from packs,
 * library sites as named chips that gather when they crowd, the open project's issues as pins
 * coloured by severity, picking, hovering, the card at a pin, fly-in, the slow idle turn and the
 * camera hand-off. Nothing here edits or measures (decision 3): picking only says what was hit.
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
  PerspectiveFrustum,
  Rectangle,
} from '@cesium/core';
import {
  BillboardCollection,
  Cesium3DTileset,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  EasingFunction,
  EllipsoidTerrainProvider,
  Entity,
  HeightReference,
  HorizontalOrigin,
  ImageryLayer,
  ScreenSpaceEventHandler,
  SceneTransforms,
  ScreenSpaceEventType,
  VerticalOrigin,
  type CesiumWidget,
} from '@cesium/engine';
import type { GlobeSite, RasterPackInfo, TilesetEntry } from '@aio/schema';
import { FetchSource, type Source } from 'pmtiles';
import { padBounds, siteToGlobe, type Bounds, type GlobeCamera, type SiteCamera } from '../camera';
import { CHIP, groupChips, placeCard, type Insets, type PlacedChip } from '../chips';
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
  chipFont,
  chipSize,
  clusterChip,
  forgetChips,
  issuePin,
  measurePin,
  siteChip,
  type PinState,
} from './pins';
import { createOnlineSatelliteProvider } from './onlineSatellite';
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

/**
 * What the view floats over the Globe: the rings at the selected site, the label under the
 * pointer, and the card at the pin it tells of.
 */
export type GlobeTagSlot = 'selected' | 'hover' | 'card';

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
  /** The font of the chips (the app's UI font). */
  font?: string;
  /** The words on the chip of sites that gathered (the app's language); their number without. */
  clusterLabel?: (count: number) => string;
}

type Pack = RasterPackInfo;
export type SourceFor = (pack: Pick<Pack, 'kind' | 'id'>) => Source;

/** Packs are read from `aio://packs/<kind>/<id>.pmtiles` with range requests. */
export const packSource: SourceFor = (p) => new FetchSource(rasterPackUrl(p.kind, p.id));

const SITE_PREFIX = 'site:';
const ISSUE_PREFIX = 'issue:';
/**
 * From a site to the left end of its chip's sprite, which puts the centre of the chip's dot on
 * the site: `pinPosition`, the pointer and the floating elements all aim there. CSS pixels:
 * CesiumJS's billboard shader turns the offset into metres with the size of a CSS pixel, and does
 * not scale it with the billboard.
 */
const CHIP_OFFSET = new Cartesian2(-(CHIP.pad + CHIP.dotX), 0);
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** What a site's chip says, and where the site stands. */
interface SiteChip {
  name: string;
  open: number;
  lonLat: readonly [number, number];
  /** The height of the ground it is drawn on, metres above the ellipsoid. */
  height: number;
}

/** A longitude or a difference of two, degrees, as the nearest turn: from -180 to 180. */
const turn = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
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
  /** The chips that stand for several sites now: how many, and which (ids in order). */
  clusters: { count: number; sites: string[] }[];
  /**
   * Every chip drawn now, a site's own or a gathered one: the sites it stands for and its box in
   * CSS pixels of the canvas (which a chip partly out of view runs past).
   */
  chips: { sites: string[]; x: number; y: number; width: number; height: number }[];
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
  private onlineSatellite = false;
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
  private readonly font: string;
  /** The page's font faces; absent where the browser has no such set. */
  private readonly fonts = (document as { fonts?: FontFaceSet }).fonts;
  /** What each site's chip says, by entity id: a chip is drawn again when its state changes. */
  private readonly chips = new Map<string, SiteChip>();
  /** The sites whose own chip is not drawn (entity ids): gathered, or behind the Earth. */
  private readonly hidden = new Set<string>();
  /** One chip for each group of sites that gathered; those past the groups are not shown. */
  private readonly gatheredChips = new BillboardCollection();
  /** The groups now drawn: the ids of their sites, in order. */
  private gathered: string[][] = [];
  /** The groups and their drawings at the last pass: the same again changes nothing. */
  private gatheredAs = '';
  /** The view the chips were last gathered for. */
  private readonly gatheredFor = { view: new Matrix4(), width: 0, height: 0 };
  /** The ground under a site may have changed (terrain came in or went): look after this frame. */
  private groundStale = false;
  private selected: string | null = null;
  private pointerHover: GlobeHover | null = null;
  private pointerAnchor: Cartesian3 | null = null;
  private listHover: string | null = null;
  private readonly tags: Partial<Record<GlobeTagSlot, HTMLElement>> = {};
  private card: GlobePick | null = null;
  private cardInsets = NO_INSETS;
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
    this.font = o.font ?? 'sans-serif';
    const widget = this.widget;
    void widget.dataSources.add(this.sites);
    void widget.dataSources.add(this.issues);
    void widget.dataSources.add(this.measure);
    widget.scene.primitives.add(this.gatheredChips);
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
    const fonts = this.fonts;
    if (fonts) {
      const loaded = (e: FontFaceSetLoadEvent) => {
        this.redrawChips(e.fontfaces);
      };
      fonts.addEventListener('loadingdone', loaded);
      this.unlisten.push(() => {
        fonts.removeEventListener('loadingdone', loaded);
      });
    }
    this.unlisten.push(
      widget.scene.postRender.addEventListener(() => {
        this.followGround();
        this.gatherIfMoved();
        this.placeTags();
      }),
      // once the view has come to rest and its tiles are in, the street tiles agree on one style
      widget.scene.camera.moveEnd.addEventListener(() => {
        this.syncStreetStyle();
        this.groundChanged();
      }),
      widget.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        if (queued === 0) this.syncStreetStyle();
        // a terrain tile that came in may be the ground under a site
        this.groundChanged();
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

  /** A site hovered or focused in the list lights its chip as the pointer would. */
  setHighlighted(projectId: string | null): void {
    if (projectId === this.listHover) return;
    const before = this.hoveredSite();
    this.listHover = projectId;
    this.restyleSites([before, this.hoveredSite()]);
    this.placeTags();
  }

  /** The selected site (its card is open): its chip wears the outline and the rings leave it. */
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

  /** A site's chip as it is now: at rest, lit or selected. */
  private chipImage(projectId: string, chip: SiteChip): HTMLCanvasElement {
    return siteChip(
      chip.name,
      chip.open,
      chip.open > 0 ? 'attention' : 'clear',
      this.pinState(projectId),
      this.palette,
      this.g.pixelRatio,
      this.font,
    ).canvas;
  }

  private restyleSites(ids: readonly (string | null)[]): void {
    for (const id of new Set(ids)) {
      if (id === null) continue;
      const entity = this.sites.entities.getById(`${SITE_PREFIX}${id}`);
      const chip = entity && this.chips.get(entity.id);
      if (!entity?.billboard || !chip) continue;
      entity.billboard.image = new ConstantProperty(this.chipImage(id, chip));
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
      this.flyToSites(id.flatMap((e) => (e instanceof Entity ? [e.id] : [])));
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
   * Give the Globe an element to keep at the selected site, under the pointer or (the card) by
   * a pin (`null` takes it back). The view fills it; the Globe only moves it, after each frame
   * it draws.
   */
  bindTag(slot: GlobeTagSlot, el: HTMLElement | null): void {
    if (el) this.tags[slot] = el;
    else Reflect.deleteProperty(this.tags, slot);
    this.placeTags();
  }

  /** The pin the card tells of, a site's or an issue's: the card slot is kept by it. */
  setCard(pick: GlobePick | null): void {
    this.card = pick;
    this.placeTags();
  }

  /**
   * The room the screen's own controls take at each edge (`null`: none): the card stays clear of
   * it, and so do the chips of the sites a flight frames (`flyHome`, a click on a gathered chip).
   */
  setCardInsets(insets: Insets | null): void {
    this.cardInsets = insets ?? NO_INSETS;
    this.placeTags();
  }

  /** Place the floating elements again: the card's size changed with what it holds. */
  layoutCard(): void {
    this.placeTags();
  }

  private sitePosition(projectId: string | null): Cartesian3 | null {
    if (projectId === null) return null;
    const e = this.sites.entities.getById(`${SITE_PREFIX}${projectId}`);
    return e?.position?.getValue(this.widget.clock.currentTime) ?? null;
  }

  private cardPosition(): Cartesian3 | null {
    const pick = this.card;
    if (!pick) return null;
    if (pick.kind === 'site') return this.sitePosition(pick.projectId);
    const e = this.issues.entities.getById(`${ISSUE_PREFIX}${pick.projectId}|${pick.issueId}`);
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
      card: this.cardPosition(),
    };
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, this.scene.camera.positionWC);
    for (const slot of ['selected', 'hover', 'card'] as const) {
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
      if (slot !== 'card') {
        el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
        continue;
      }
      // the card has a size, its content's: it goes under or over the pin and stays in the view
      const canvas = this.scene.canvas;
      const place = placeCard(
        at,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: canvas.clientWidth, height: canvas.clientHeight },
        this.cardInsets,
      );
      el.style.transform = `translate3d(${String(place.left)}px, ${String(place.top)}px, 0)`;
      if (el.dataset.side !== place.side) el.dataset.side = place.side;
    }
  }

  // ---------------------------------------------------------------- the Earth: layers and terrain

  /** The look: the street map (default), imagery packs over it, or the old Natural Earth raster. */
  setStyle(style: GlobeStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.queueRebuild();
  }

  /**
   * Online satellite may be drawn (the person switched it on; main still decides tile by tile).
   * It shows in the Satellite look only, under the imagery packs.
   */
  setOnlineSatellite(on: boolean): void {
    if (on === this.onlineSatellite) return;
    this.onlineSatellite = on;
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
    // the sites stand on another ground now (back on the ellipsoid without terrain)
    this.groundStale = true;
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
      onlineSatellite: this.onlineSatellite,
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
        } else if (entry.kind === 'online-satellite') {
          layers.add(new ImageryLayer(createOnlineSatelliteProvider()));
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
    // the ground under the sites rises or sinks with it
    this.groundChanged();
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- pins

  /** Library projects as chips at their origins, gathered into one where they would overlap. */
  setSites(sites: readonly GlobeSite[]): void {
    const entities = this.sites.entities;
    const ids = new Set(sites.map((s) => `${SITE_PREFIX}${s.projectId}`));
    entities.suspendEvents();
    for (const gone of entities.values.filter((e) => !ids.has(e.id))) {
      entities.remove(gone);
      this.chips.delete(gone.id);
      this.hidden.delete(gone.id);
    }
    for (const s of sites) {
      const id = `${SITE_PREFIX}${s.projectId}`;
      const lonLat: [number, number] = [s.lonLat[0], s.lonLat[1]];
      const was = this.chips.get(id);
      // a site that stays where it was keeps its ground until `settleSites` has looked again
      const height = was?.lonLat[0] === lonLat[0] && was.lonLat[1] === lonLat[1] ? was.height : 0;
      const chip: SiteChip = { name: s.name, open: s.issues.open, lonLat, height };
      this.chips.set(id, chip);
      const position = Cartesian3.fromDegrees(lonLat[0], lonLat[1], height);
      const image = this.chipImage(s.projectId, chip);
      // a site already there keeps its entity: its chip does not go and come back, and stays
      // hidden if it is gathered
      const known = entities.getById(id);
      if (known?.billboard) {
        known.name = s.name;
        known.position = new ConstantPositionProperty(position);
        known.billboard.image = new ConstantProperty(image);
        continue;
      }
      entities.add({
        id,
        name: s.name,
        position,
        billboard: {
          image,
          // sprites are drawn in device pixels; CesiumJS sizes billboards in CSS pixels
          scale: 1 / this.g.pixelRatio,
          // the chip runs to the right of its dot, and the dot is the site
          horizontalOrigin: HorizontalOrigin.LEFT,
          verticalOrigin: VerticalOrigin.CENTER,
          pixelOffset: CHIP_OFFSET,
          // no height reference: the site's position is on the ground already (`settleSites`)
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    entities.resumeEvents();
    this.settleSites();
    // the faces these words need, asked for now: `loadingdone` then draws the chips again
    const words = [...sites.map((s) => s.name), this.clusterWords(2), '0123456789+…'].join(' ');
    void this.fonts?.load(chipFont(this.font), words).catch(() => undefined);
    // a site may have moved or changed its count under the same groups
    this.gatheredAs = '';
    this.gather();
    this.scene.requestRender();
  }

  private clusterWords(count: number): string {
    return this.o.clusterLabel?.(count) ?? String(count);
  }

  /** The ground under the sites may have changed; nothing to look at without terrain. */
  private groundChanged(): void {
    if (this.terrainIds.length > 0) this.groundStale = true;
  }

  /**
   * Put every site on the ground as it is drawn now; says whether one moved. With terrain that
   * is the height of the most detailed tile loaded under the site, exaggeration included
   * (`Globe.getHeight`; where no tile is loaded, the site stays as it stood); without, the
   * ellipsoid. The chip is drawn at the site's position, and the pointer, the rings, the card,
   * `pinPosition` and the gathering all read that same position. (A billboard CesiumJS clamps
   * itself keeps where it stands to itself, so nothing else could point at it: with terrain and
   * a tilted view the card and the rings stood tens of pixels off the chip.)
   */
  private settleSites(): boolean {
    const terrain = this.terrainIds.length > 0;
    const entities = this.sites.entities;
    let moved = false;
    for (const [id, chip] of this.chips) {
      const [lon, lat] = chip.lonLat;
      const height = terrain
        ? (this.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? chip.height)
        : 0;
      // (a centimetre is nothing on screen, and a tile read twice differs by less)
      if (Math.abs(height - chip.height) < 0.01) continue;
      chip.height = height;
      const entity = entities.getById(id);
      if (entity)
        entity.position = new ConstantPositionProperty(Cartesian3.fromDegrees(lon, lat, height));
      moved = true;
    }
    return moved;
  }

  /**
   * After a frame in which the ground may have changed: the sites follow it, and are gathered
   * again where they stand now. Nothing is looked at otherwise, and never without terrain.
   */
  private followGround(): void {
    if (!this.groundStale || this.destroyed) return;
    this.groundStale = false;
    if (!this.settleSites()) return;
    // the gathered chips stand in the middle of their sites: place them again as well
    this.gatheredAs = '';
    this.gather();
    this.scene.requestRender();
  }

  /**
   * A font face arrived. A canvas draws with the faces loaded at that moment, so a chip drawn
   * before the face of its words has another font's glyphs and width: every chip is drawn again,
   * and gathered again by its new width.
   */
  private redrawChips(faces: readonly FontFace[]): void {
    const families = this.font.toLowerCase();
    // only for a face the chips may be drawn in
    if (!faces.some((f) => families.includes(f.family.replace(/["']/g, '').toLowerCase()))) return;
    forgetChips();
    this.restyleSites([...this.chips.keys()].map((id) => id.slice(SITE_PREFIX.length)));
    this.gather();
  }

  /** Gather the chips again when the view has moved since the last time. */
  private gatherIfMoved(): void {
    if (this.destroyed) return;
    const { viewMatrix } = this.scene.camera;
    const { clientWidth, clientHeight } = this.scene.canvas;
    const last = this.gatheredFor;
    if (
      Matrix4.equals(viewMatrix, last.view) &&
      clientWidth === last.width &&
      clientHeight === last.height
    )
      return;
    Matrix4.clone(viewMatrix, last.view);
    last.width = clientWidth;
    last.height = clientHeight;
    // what a pass shows or hides is no move of the view: the frame it asks for ends here
    if (this.gather()) this.scene.requestRender();
  }

  /**
   * Chips that would overlap are drawn as one (`groupChips`): their sites' own chips are not
   * drawn, nor are those of sites behind the Earth, and each group has one chip in the middle
   * of its sites. Says whether what is drawn changed.
   */
  private gather(): boolean {
    const scene = this.scene;
    const entities = this.sites.entities;
    const time = this.widget.clock.currentTime;
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, scene.camera.positionWC);
    const inView: PlacedChip[] = [];
    for (const [id, chip] of this.chips) {
      const p = entities.getById(id)?.position?.getValue(time);
      const at =
        p && occluder.isPointVisible(p)
          ? SceneTransforms.worldToWindowCoordinates(scene, p)
          : undefined;
      if (at) inView.push({ id, x: at.x, y: at.y, ...chipSize(chip.name, chip.open, this.font) });
    }
    const groups = groupChips(inView, (count) =>
      chipSize(this.clusterWords(count), 0, this.font),
    ).filter((group) => group.ids.length > 1);
    const alone = new Set(inView.map((chip) => chip.id));
    for (const id of groups.flatMap((group) => group.ids)) alone.delete(id);

    let changed = false;
    for (const entity of entities.values) {
      const hide = !alone.has(entity.id);
      if (!entity.billboard || hide === this.hidden.has(entity.id)) continue;
      // by its size, not by `show`: CesiumJS gives up the billboard of an entity that is not
      // shown and loads its image again when it is, so a chip would come back a frame late.
      // Nothing else sets a site's scale.
      entity.billboard.scale = new ConstantProperty(hide ? 0 : 1 / this.g.pixelRatio);
      if (hide) this.hidden.add(entity.id);
      else this.hidden.delete(entity.id);
      changed = true;
    }

    const drawn = groups.map(({ ids }) => ({
      ids,
      sprite: clusterChip(
        this.clusterWords(ids.length),
        ids.some((id) => (this.chips.get(id)?.open ?? 0) > 0) ? 'attention' : 'clear',
        this.palette,
        this.g.pixelRatio,
        this.font,
      ),
    }));
    const as = JSON.stringify(drawn.map(({ ids, sprite }) => [sprite.id, ids]));
    if (as === this.gatheredAs) return changed;
    this.gatheredAs = as;
    this.gathered = drawn.map(({ ids }) => ids.map((id) => id.slice(SITE_PREFIX.length)));
    const pool = this.gatheredChips;
    drawn.forEach(({ ids, sprite }, i) => {
      const members = ids.flatMap((id) => entities.getById(id) ?? []);
      const middle = new Cartesian3();
      for (const member of members) {
        const p = member.position?.getValue(time);
        if (p) Cartesian3.add(middle, p, middle);
      }
      // the middle of its sites in the world: it does not shift as the view turns
      const position = Cartesian3.divideByScalar(middle, members.length, middle);
      const billboard =
        i < pool.length
          ? pool.get(i)
          : pool.add({
              position,
              // sprites are drawn in device pixels; CesiumJS sizes billboards in CSS pixels
              scale: 1 / this.g.pixelRatio,
              verticalOrigin: VerticalOrigin.CENTER,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            });
      billboard.position = position;
      // what a pick of it says it hit: the sites it stands for
      billboard.id = members;
      // by the drawing's id: the atlas keeps one copy however often a chip is shown
      billboard.setImage(sprite.id, sprite.canvas);
      billboard.show = true;
    });
    for (let i = drawn.length; i < pool.length; i++) pool.get(i).show = false;
    return true;
  }

  /** The open project's issues as pins at their 3D anchors, coloured by severity. */
  setIssuePins(projectId: string, georef: SiteGeoref, pins: readonly IssuePin[]): void {
    // on its own, before the new ones go in: within one batch CesiumJS sets the removal of an
    // id against its addition, tells nobody, and the old pin stays drawn
    this.issues.entities.removeAll();
    this.issues.entities.suspendEvents();
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

  /**
   * The room a flight to these sites (entity ids) leaves at each edge of the view: what the
   * screen's own controls take, then what a chip takes around its site. A site's own chip runs
   * to the right of its dot; gathered, the sites share one chip centred on the middle of them.
   */
  private chipRoom(ids: readonly string[]): Insets {
    let east = 0;
    for (const id of ids) {
      const chip = this.chips.get(id);
      if (chip) east = Math.max(east, chipSize(chip.name, chip.open, this.font).width - CHIP.dotX);
    }
    const half =
      ids.length > 1 ? chipSize(this.clusterWords(ids.length), 0, this.font).width / 2 : 0;
    // and the clear room of a sprite: an outline stays whole, a pixel of rounding costs nothing
    const above = CHIP.height / 2 + CHIP.pad;
    const edge = this.cardInsets;
    return {
      top: edge.top + above,
      right: edge.right + Math.max(east, half) + CHIP.pad,
      bottom: edge.bottom + above,
      left: edge.left + Math.max(CHIP.dotX, half) + CHIP.pad,
    };
  }

  /**
   * The box to fly to so that the chips of these sites (entity ids), which lie in `bounds`, are
   * whole in the view and clear of the screen's controls (`padBounds`).
   */
  private frame(bounds: Readonly<Bounds>, ids: readonly string[]): Rectangle {
    const { clientWidth: width, clientHeight: height } = this.scene.canvas;
    const frustum = this.scene.camera.frustum;
    const fov = frustum instanceof PerspectiveFrustum ? frustum.fov : undefined;
    const [west, south, east, north] = padBounds(
      bounds,
      { width, height },
      this.chipRoom(ids),
      fov === undefined ? {} : { fovDeg: CMath.toDegrees(fov) },
    );
    // a box padded past the antimeridian: CesiumJS reads west beyond east as a box across it
    const wrapped = (lon: number) => (Math.abs(lon) > 180 ? turn(lon) : lon);
    return Rectangle.fromDegrees(wrapped(west), south, wrapped(east), north);
  }

  /**
   * Fly to where these sites (entity ids) are all in view, as near as their chips allow: sites
   * that gathered part there, unless they stand at the same place.
   */
  private flyToSites(ids: readonly string[]): void {
    const places = ids.flatMap((id) => {
      const chip = this.chips.get(id);
      return chip ? [chip.lonLat] : [];
    });
    const [first] = places;
    if (!first) return;
    // longitudes as they lie around the first site, so a group across the antimeridian is one box
    const lons = places.map(([lon]) => first[0] + turn(lon - first[0]));
    const lats = places.map(([, lat]) => lat);
    const bounds: Bounds = [
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats),
    ];
    this.scene.camera.flyTo({
      destination: this.frame(bounds, ids),
      duration: this.duration(1.6),
    });
  }

  /**
   * The whole Earth, or a box around the given sites (`sitesBounds`), with room for their chips
   * and the screen's controls around it.
   */
  flyHome(bounds: readonly [number, number, number, number] | null): void {
    this.touch();
    const rect = bounds
      ? this.frame(bounds, [...this.chips.keys()])
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
      clusters: this.gathered.map((sites) => ({ count: sites.length, sites })),
      chips: this.chipBoxes(),
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

  /** Where every chip drawn now is, a site's own and a gathered one (`GlobeInspection.chips`). */
  private chipBoxes(): GlobeInspection['chips'] {
    const scene = this.scene;
    const time = this.widget.clock.currentTime;
    const boxes: GlobeInspection['chips'] = [];
    for (const [id, chip] of this.chips) {
      if (this.hidden.has(id)) continue;
      const p = this.sites.entities.getById(id)?.position?.getValue(time);
      const at = p && SceneTransforms.worldToWindowCoordinates(scene, p);
      if (!at) continue;
      const { width, height } = chipSize(chip.name, chip.open, this.font);
      // the dot is the site; the chip runs to the right of it
      boxes.push({
        sites: [id.slice(SITE_PREFIX.length)],
        x: at.x - CHIP.dotX,
        y: at.y - height / 2,
        width,
        height,
      });
    }
    this.gathered.forEach((sites, i) => {
      const at =
        i < this.gatheredChips.length
          ? SceneTransforms.worldToWindowCoordinates(scene, this.gatheredChips.get(i).position)
          : undefined;
      if (!at) return;
      const { width, height } = chipSize(this.clusterWords(sites.length), 0, this.font);
      boxes.push({ sites, x: at.x - width / 2, y: at.y - height / 2, width, height });
    });
    return boxes;
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
