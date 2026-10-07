/**
 * The Globe's scene: the offline CesiumWidget, imagery and terrain from packs, library sites as
 * clustered pins, the open project's issues as pins coloured by severity, picking, fly-in and the
 * camera hand-off. Nothing here edits or measures (decision 3): picking only says what was hit.
 */
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  HeadingPitchRange,
  Matrix4,
  Math as CMath,
  Rectangle,
} from '@cesium/core';
import type { ImageryLayer } from '@cesium/engine';
import {
  Cesium3DTileset,
  CustomDataSource,
  EllipsoidTerrainProvider,
  Entity,
  HeightReference,
  LabelStyle,
  ScreenSpaceEventHandler,
  SceneTransforms,
  ScreenSpaceEventType,
  VerticalOrigin,
  type CesiumWidget,
} from '@cesium/engine';
import type { GlobeSite, RasterPackInfo, TilesetEntry } from '@aio/schema';
import { FetchSource, type Source } from 'pmtiles';
import { siteToGlobe, type GlobeCamera, type SiteCamera } from '../camera';
import {
  ecefToGeodetic,
  enuBasis,
  localToEcef,
  localToEcefMatrix,
  type SiteGeoref,
} from '../geodesy';
import { OFFLINE_CESIUM } from '../offline';
import { creditLines } from '../credits';
import type { IssuePin } from '../sites';
import { NO_GEOID, type Geoid } from '../terrarium';
import { imageryLayerOrder, rasterPackUrl } from '../tiles';
import { PmtilesImageryProvider, asImageryProvider, packTerrainProvider } from './providers';
import {
  configureCesiumBase,
  createOfflineWidget,
  naturalEarthLayer,
  type GlobeTier,
} from './setup';

export type GlobePick =
  { kind: 'site'; projectId: string } | { kind: 'issue'; projectId: string; issueId: string };

export interface GlobeControllerOptions {
  container: HTMLElement;
  /** The app's copy of Cesium's workers and assets. */
  baseUrl: string;
  tier: GlobeTier;
  /** Jump instead of flying (OS or Settings reduced motion). */
  reducedMotion: () => boolean;
  onPick: (pick: GlobePick | null) => void;
  /** The credit lines of what is drawn (Natural Earth II, then each pack once). */
  onCredits?: (lines: string[]) => void;
  /** Geoid undulation for EGM terrain packs; none bundled yet. */
  geoid?: Geoid;
}

type Pack = RasterPackInfo;
export type SourceFor = (pack: Pick<Pack, 'kind' | 'id'>) => Source;

/** Packs are read from `aio://packs/<kind>/<id>.pmtiles` with range requests. */
export const packSource: SourceFor = (p) => new FetchSource(rasterPackUrl(p.kind, p.id));

const SITE_PREFIX = 'site:';
const ISSUE_PREFIX = 'issue:';

/** A round map pin, drawn once per colour (no image is fetched). */
const pinCache = new Map<string, HTMLCanvasElement>();
function pinImage(fill: string, ring = '#ffffff', size = 28): HTMLCanvasElement {
  const key = `${fill}/${ring}/${String(size)}`;
  const hit = pinCache.get(key);
  if (hit) return hit;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
  pinCache.set(key, c);
  return c;
}

function clusterImage(count: number): HTMLCanvasElement {
  const size = count < 10 ? 34 : 40;
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.drawImage(pinImage('#1f9d7a', '#ffffff', size), 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${String(size * 0.42)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), size / 2, size / 2 + 1);
  }
  return c;
}

export interface GlobeInspection {
  tilesLoaded: boolean;
  frame: number;
  imagery: string[];
  imageryTiles: number;
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
}

export class GlobeController {
  private imageryProviders: PmtilesImageryProvider[] = [];
  private imageryLayers: ImageryLayer[] = [];
  private terrainIds: string[] = [];
  private terrainDecoded: (() => number) | null = null;
  private readonly sites = new CustomDataSource('sites');
  private readonly issues = new CustomDataSource('issues');
  private readonly handler: ScreenSpaceEventHandler;
  private credits: string[] = [];
  private tilesets: { id: string; tileset: Cesium3DTileset }[] = [];
  private tilesetGeneration = 0;

  private constructor(
    readonly widget: CesiumWidget,
    private readonly o: GlobeControllerOptions,
  ) {
    const clustering = this.sites.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 40;
    clustering.minimumClusterSize = 2;
    clustering.clusterEvent.addEventListener((entities, cluster) => {
      cluster.label.show = false;
      cluster.billboard.show = true;
      // the typings say string; a Billboard takes a canvas as its image as well
      cluster.billboard.image = clusterImage(entities.length) as unknown as string;
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
    });
    void widget.dataSources.add(this.sites);
    void widget.dataSources.add(this.issues);
    // a render error stops CesiumJS's render loop: say so in the log (diagnostics, tests)
    widget.scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
      console.error('The Globe stopped drawing:', error);
    });
    this.handler = new ScreenSpaceEventHandler(widget.scene.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => {
      this.pick(e.position);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Build the Globe in `container` (Natural Earth II first, then packs when they are set). */
  static async create(o: GlobeControllerOptions): Promise<GlobeController> {
    configureCesiumBase(o.baseUrl);
    const baseLayer = await naturalEarthLayer();
    const widget = createOfflineWidget(o.container, { tier: o.tier, baseLayer });
    return new GlobeController(widget, o);
  }

  private get scene() {
    return this.widget.scene;
  }

  private pick(position: Cartesian2): void {
    const hit = this.scene.pick(position) as { id?: unknown } | undefined;
    const id = hit?.id;
    // a cluster: zoom to its sites
    if (Array.isArray(id)) {
      const entities = id.filter((e): e is Entity => e instanceof Entity);
      void this.widget.flyTo(entities, { duration: this.duration(1.5) });
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

  /**
   * Imagery packs as layers over Natural Earth II (least detailed lowest), and terrain packs as
   * one terrain (none on the Low tier). Replaces what was there.
   */
  setPacks(imagery: readonly Pack[], terrain: readonly Pack[], sourceFor: SourceFor = packSource) {
    const layers = this.scene.imageryLayers;
    for (const l of this.imageryLayers) layers.remove(l, true);
    this.imageryProviders = imageryLayerOrder(imagery).map(
      (p) => new PmtilesImageryProvider(p, sourceFor(p)),
    );
    this.imageryLayers = this.imageryProviders.map((p) =>
      layers.addImageryProvider(asImageryProvider(p)),
    );
    const useTerrain = this.o.tier !== 'low' && terrain.length > 0;
    if (useTerrain) {
      const provider = packTerrainProvider({
        packs: terrain,
        sourceFor,
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
    this.credits = creditLines([...imagery, ...(useTerrain ? terrain : [])]);
    this.o.onCredits?.(this.credits);
    this.scene.requestRender();
  }

  /** Vertical exaggeration of the terrain (Globe settings). */
  setExaggeration(k: number): void {
    this.scene.verticalExaggeration = k;
    this.scene.requestRender();
  }

  /** Library projects as pins at their origins, clustered when they crowd. */
  setSites(sites: readonly GlobeSite[]): void {
    this.sites.entities.suspendEvents();
    this.sites.entities.removeAll();
    for (const s of sites) {
      this.sites.entities.add({
        id: `${SITE_PREFIX}${s.projectId}`,
        name: s.name,
        position: Cartesian3.fromDegrees(s.lonLat[0], s.lonLat[1], 0),
        billboard: {
          image: pinImage(s.issues.open > 0 ? '#d0a03a' : '#1f9d7a'),
          verticalOrigin: VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: s.name,
          font: '13px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 18),
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
          image: pinImage(p.colour, '#ffffff', 20),
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
        this.scene.primitives.add(tileset);
        this.tilesets.push({ id: e.id, tileset });
      } catch (err) {
        console.warn(`The Globe could not load tileset ${e.id}:`, err);
      }
    }
    this.scene.requestRender();
  }

  /** The whole Earth, or a box around the given sites. */
  flyHome(bounds: readonly [number, number, number, number] | null): void {
    const rect = bounds
      ? Rectangle.fromDegrees(...bounds)
      : Rectangle.fromDegrees(-30, -40, 110, 70);
    this.scene.camera.flyTo({ destination: rect, duration: this.duration(1.5) });
  }

  /** Fly to a site: looking down at 45 degrees from the south, `range` metres away. */
  flyToSite(lonLat: readonly [number, number], range = 1500): Promise<void> {
    const centre = Cartesian3.fromDegrees(lonLat[0], lonLat[1], 0);
    return new Promise((resolve) => {
      this.scene.camera.flyToBoundingSphere(new BoundingSphere(centre, 50), {
        offset: new HeadingPitchRange(0, CMath.toRadians(-45), range),
        duration: this.duration(2),
        complete: resolve,
        cancel: resolve,
      });
    });
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
      imagery: this.imageryProviders.map((p) => p.pack.id),
      imageryTiles: this.imageryProviders.reduce((n, p) => n + p.tilesLoaded, 0),
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
      flying:
        (scene.camera as unknown as { _currentFlight?: unknown })._currentFlight !== undefined,
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
    const canvas = this.scene.canvas;
    this.handler.destroy();
    this.widget.destroy();
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
