import type { AssetRef, Layer, LayerKind } from '@aio/schema';
import type { CameraRequest, OpenProject, Selection, Workspace } from '@aio/workspace';
import {
  Box3,
  DoubleSide,
  Plane,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Material,
  type Mesh,
  type Object3D,
  type Side,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { StoreApi } from 'zustand/vanilla';
import { PICK_LAYER, isMesh, selectableNode } from '../adapters/model';
import {
  frameBox,
  headingDeg,
  poseForPoint,
  poseForPreset,
  easeInOutCubic,
  type CameraPose,
  type ViewPreset,
} from '../camera/cameraMath';
import { engineConfig, type StageQuality } from '../config';
import { LayerSync } from '../layers/layerSync';
import { FrameStats } from '../overlay/declutter';
import { Overlay, type CalloutSpec } from '../overlay/Overlay';
import { getAdapter as registryAdapter } from '../registry';
import { MeasureTool } from '../tools/measure';
import { DEFAULT_SECTION, applySection, type SectionState } from '../tools/section';
import type {
  ClientRectLike,
  EngineStage,
  EnvironmentInfo,
  EnvironmentSettings,
  LabelMode,
  LayerAdapter,
  RaycastProvider,
  SavedView,
  StageTool,
} from '../types';
import { defaultEnvironment, siteLocation, type SiteLocation } from './envDefaults';
import { Environment } from './environment';
import type { GroundUniforms } from './groundShading';
import { skyDirection, solarPosition } from './solar';
import { estimateGpuBytes, formatPerf, type PerfStats } from './perf';
import { Highlighter } from './highlight';
import { moduleTextures } from './sharedTextures';
import { reducedMotion } from '../motion';

export interface StageOptions {
  container: HTMLElement;
  store: StoreApi<Workspace>;
  resolveUrl: (projectId: string, ref: AssetRef) => string;
  /** Injected in tests, where WebGL is unavailable. */
  createRenderer?: (canvas: HTMLCanvasElement) => WebGLRenderer;
  getAdapter?: (kind: LayerKind) => LayerAdapter | undefined;
  devTools?: boolean;
}

export function createDefaultRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const antialias = engineConfig().quality.antialias !== false;
  const r = new WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, engineConfig().quality.maxPixelRatio));
  return r;
}

type AssetTag = NonNullable<Extract<Layer, { kind: 'mesh' }>['tags']>[number];

const FLY_MS = 900;
/**
 * The bounding sphere of a tall or long asset is mostly empty air: the home view fits it without
 * the usual margin, so the asset fills the stage on first open.
 */
const HOME_MARGIN = 1.05;
/** The orbit stays above the horizon (a little below, to look along the ground). */
const MAX_POLAR = Math.PI * 0.53;
const CLICK_SLOP_PX = 5;
/** Orbit glide: the share of the remaining motion taken per 60 Hz frame. */
const DAMPING = 0.08;

/**
 * The damping factor for a frame of `dtMs`, so the glide lasts the same time at 60 fps and on a
 * slow GPU (OrbitControls damps per update call; at 5 fps a fixed factor glides for 30 s).
 */
export function dampingFor(dtMs: number): number {
  const frames = Math.min(Math.max(dtMs, 0), 250) / (1000 / 60);
  return 1 - Math.pow(1 - DAMPING, frames);
}

interface Flight {
  from: CameraPose;
  to: CameraPose;
  start: number;
  ms: number;
}

const visibleChain = (o: Object3D | null): boolean => {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

/** Bounds of visible content, leaving out terrain (a modelled sea or mainland dwarfs the asset). */
function expandWithoutTerrain(o: Object3D, box: Box3, tmp: Box3) {
  if (!o.visible || o.userData.type === 'terrain') return;
  if (isMesh(o)) {
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox) box.union(tmp.copy(g.boundingBox).applyMatrix4(o.matrixWorld));
  }
  for (const c of o.children) expandWithoutTerrain(c, box, tmp);
}

/** Display name from glTF extras; three.js copies the node name into userData.name, so skip that. */
function extrasName(node: Object3D): string | null {
  const n: unknown = node.userData.name;
  return typeof n === 'string' && n !== node.name ? n : null;
}

/** "Access_Indicative" reads "Access indicative". */
export function groupLabel(area: string): string {
  const words = area.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(' ');
}

/**
 * The 3D stage behind SceneView: renderer, camera, controls, render on demand, layers from the
 * open project, picking, callouts, camera requests, section and measure tools.
 */
export class Stage implements EngineStage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.1, 20000);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Where OrbitControls hung its keydown listener: the canvas's root node when it connected. */
  private readonly controlsRoot: Node;
  readonly clippingPlanes: Plane[] = [];
  readonly canvas: HTMLCanvasElement;

  private readonly env: Environment;
  private readonly overlay: Overlay;
  private readonly highlight: Highlighter;
  private readonly measureTool = new MeasureTool();
  private readonly ro: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly getAdapter: (kind: LayerKind) => LayerAdapter | undefined;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly stats = new FrameStats(120);
  private readonly targets = new Map<Object3D, string>();
  private readonly receivers = new Set<Mesh>();
  private readonly providers = new Set<RaycastProvider>();
  private readonly frameCbs = new Set<(dtMs: number) => void>();
  private readonly holders = new Map<symbol, string>();
  private readonly stateCbs = new Set<() => void>();
  private readonly anchors = new WeakMap<Object3D, Vector3>();
  private readonly volumes = new WeakMap<Object3D, number>();
  private readonly nodeCache = new WeakMap<Object3D, Map<string, Object3D | null>>();
  private readonly groupNodes = new Map<string, Object3D[]>();
  private readonly warnedKinds = new Set<string>();
  private readonly t0 = performance.now();

  private sync: LayerSync | null = null;
  private project: OpenProject | null = null;
  private need = true;
  private raf = 0;
  private lastNow = 0;
  private width = 0;
  private height = 0;
  private flight: Flight | null = null;
  private autoFit = true;
  private shadowDirty = true;
  private pendingCamera: CameraRequest | null = null;
  private pendingSelection: Selection | null = null;
  private hoverRaf = 0;
  private hoverEvent: PointerEvent | null = null;
  private downAt: [number, number] | null = null;
  private readonly clickClaims = new Set<(e: PointerEvent) => boolean>();
  private perfHold: (() => void) | null = null;
  private lastRenderMs = 0;
  private gpuAt = -Infinity;
  private gpuBytes = 0;
  private lost = false;
  private _quality: StageQuality = { ...engineConfig().quality };
  private disposed = false;
  private contentCentre = new Vector3();
  private _tool: StageTool = 'select';
  private _section: SectionState = { ...DEFAULT_SECTION };
  private _labelMode: LabelMode = 'key';
  private keepOut: (() => Iterable<ClientRectLike>) | null = null;
  private envSettings: EnvironmentSettings = {
    mode: 'studio',
    timeMs: Date.UTC(2023, 5, 21, 9),
    water: true,
    waterLevel: null,
  };
  private location: SiteLocation | null = null;
  private sunPos = {
    azimuthDeg: 135,
    elevationDeg: 45,
    direction: [0, 0, 0] as [number, number, number],
  };
  private dataWaterLevel: number | null = null;
  private maskDirty = false;

  constructor(private readonly opts: StageOptions) {
    this.getAdapter = opts.getAdapter ?? registryAdapter;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      outline: 'none',
      touchAction: 'none',
    });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D scene');
    opts.container.appendChild(this.canvas);

    const r = (opts.createRenderer ?? createDefaultRenderer)(this.canvas);
    r.outputColorSpace = SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.localClippingEnabled = true;
    this.renderer = r;

    this.camera.position.set(60, 45, 60);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controlsRoot = this.canvas.getRootNode();
    this.controls.enableDamping = true;
    this.controls.dampingFactor = DAMPING;
    this.controls.maxPolarAngle = MAX_POLAR;
    this.controls.addEventListener('change', () => {
      this.need = true;
    });
    this.controls.addEventListener('start', () => {
      this.flight = null;
      this.autoFit = false;
    });

    this.env = new Environment(this.scene, r);
    this.env.setQuality(this.envQuality());
    this.applyEnvironment();
    // perf counters cover a whole frame; renderNow resets them
    if (r.info as Partial<WebGLRenderer['info']> | undefined) r.info.autoReset = false;
    this.highlight = new Highlighter(this.clippingPlanes);
    this.scene.add(this.highlight.group, this.measureTool.line);
    this.overlay = new Overlay(opts.container, {
      onCalloutClick: (id) => {
        const group = this.groupNodes.get(id);
        if (group) {
          this.frameNodes(group);
          return;
        }
        const hit = this.findNode(id);
        if (hit) opts.store.getState().select({ kind: 'asset', id, layer: hit.layerId });
      },
      onCompassClick: () => {
        this.setViewPreset('top');
      },
      requestRender: () => {
        this.requestRender();
      },
    });

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKey);

    this.ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) this.resize(box.width, box.height);
    });
    this.ro.observe(opts.container);
    const rect = opts.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) this.resize(rect.width, rect.height);

    const state = opts.store.getState();
    this.openProject(state.project);
    this.applySelection(state.selection);
    if (state.camera) this.handleCamera(state.camera);
    this.unsubscribe = opts.store.subscribe(this.onStore);

    this.raf = requestAnimationFrame(this.loop);
  }

  /* ----------------------------------------------------------------------- SceneHandle */

  get projectId(): string {
    return this.project?.id ?? '';
  }

  requestRender(): void {
    this.need = true;
  }

  onFrame(cb: (dtMs: number) => void): () => void {
    this.frameCbs.add(cb);
    return () => {
      this.frameCbs.delete(cb);
    };
  }

  holdContinuous(reason: string): () => void {
    const token = Symbol(reason);
    this.holders.set(token, reason);
    return () => {
      this.holders.delete(token);
      this.need = true;
    };
  }

  projectionReceivers(): readonly Mesh[] {
    const out = [...this.receivers].filter((m) => visibleChain(m));
    if (this.env.ground.visible) out.push(this.env.ground);
    return out;
  }

  addRaycastTarget(object: Object3D, layerId: string): () => void {
    this.targets.set(object, layerId);
    this.contentChanged();
    return () => {
      this.targets.delete(object);
      if (this.highlight.selected && this.isUnder(this.highlight.selected, object))
        this.highlight.set('select', null);
      if (this.highlight.hovered && this.isUnder(this.highlight.hovered, object))
        this.highlight.set('hover', null);
      this.contentChanged();
    };
  }

  addProjectionReceiver(mesh: Mesh): () => void {
    this.receivers.add(mesh);
    this.applySectionSide(mesh);
    return () => {
      this.receivers.delete(mesh);
    };
  }

  raycast(ndcX: number, ndcY: number): Intersection | null {
    let hit: Intersection | null = this.intersect(ndcX, ndcY)[0] ?? null;
    for (const provider of this.providers) {
      const h = provider(ndcX, ndcY);
      if (h && (!hit || h.distance < hit.distance)) hit = h;
    }
    if (hit) return hit;
    // the ground: a horizontal plane at y = 0
    this.raycaster.setFromCamera(this.ndc.set(ndcX, ndcY), this.camera);
    return this.groundHit();
  }

  raycastRay(origin: Vector3, dir: Vector3): Intersection | null {
    this.raycaster.set(origin, dir.clone().normalize());
    this.raycaster.layers.mask = 1 | (1 << PICK_LAYER);
    const hits: Intersection[] = [];
    for (const [root] of this.targets) {
      if (!visibleChain(root)) continue;
      this.raycaster.intersectObject(root, true, hits);
    }
    const hit = hits
      .filter((h) => visibleChain(h.object))
      .sort((a, b) => a.distance - b.distance)[0];
    return hit ?? this.groundHit();
  }

  addRaycastProvider(provider: RaycastProvider): () => void {
    this.providers.add(provider);
    return () => {
      this.providers.delete(provider);
    };
  }

  /** The current raycaster ray against the ground plane y = 0. */
  private groundHit(): Intersection | null {
    const p = this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
    if (!p) return null;
    return { distance: this.raycaster.ray.origin.distanceTo(p), point: p, object: this.env.ground };
  }

  /* ----------------------------------------------------------------------- EngineStage */

  get tool(): StageTool {
    return this._tool;
  }

  claimClicks(handler: (e: PointerEvent) => boolean): () => void {
    this.clickClaims.add(handler);
    return () => {
      this.clickClaims.delete(handler);
    };
  }

  setTool(tool: StageTool): void {
    if (tool === this._tool) return;
    this._tool = tool;
    if (tool !== 'measure') this.clearMeasure();
    if (tool === 'section' && !this._section.enabled) this.setSection({ enabled: true });
    this.canvas.style.cursor = tool === 'measure' ? 'crosshair' : '';
    this.emitState();
  }

  get section(): SectionState {
    return this._section;
  }

  setSection(patch: Partial<SectionState>): void {
    const wasEnabled = this._section.enabled;
    this._section = { ...this._section, ...patch };
    applySection(this.clippingPlanes, this._section, this.contentCentre);
    if (wasEnabled !== this._section.enabled)
      for (const m of this.receivers) this.applySectionSide(m);
    this.shadowDirty = true;
    this.need = true;
    this.emitState();
  }

  sectionOrigin(): Vector3 {
    return this.contentCentre.clone();
  }

  clearMeasure(): void {
    this.measureTool.clear();
    this.overlay.setMeasure(null, null, '');
    this.need = true;
  }

  setPerfOverlay(on: boolean): void {
    if (on === (this.perfHold !== null)) return;
    if (on) {
      this.stats.reset();
      this.gpuAt = -Infinity;
      this.perfHold = this.holdContinuous('perf overlay');
      this.overlay.setPerf(formatPerf(this.perfStats()));
    } else {
      this.perfHold?.();
      this.perfHold = null;
      this.overlay.setPerf(null);
    }
  }

  onStateChange(cb: () => void): () => void {
    this.stateCbs.add(cb);
    return () => {
      this.stateCbs.delete(cb);
    };
  }

  get labelMode(): LabelMode {
    return this._labelMode;
  }

  setLabelMode(mode: LabelMode): void {
    if (mode === this._labelMode) return;
    this._labelMode = mode;
    this.rebuildCallouts();
    this.need = true;
    this.emitState();
  }

  setLabelKeepOut(provider: (() => Iterable<ClientRectLike>) | null): void {
    this.keepOut = provider;
    this.overlay.setKeepOut(provider);
    this.need = true;
  }

  uiKeepOut(): ClientRectLike[] {
    return this.keepOut ? [...this.keepOut()] : [];
  }

  addLabelObstacles(provider: () => Iterable<Vector3>): () => void {
    const off = this.overlay.addObstacles(provider);
    this.need = true;
    return () => {
      off();
      this.need = true;
    };
  }

  saveView(): SavedView {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  restoreView(view: SavedView, animate = false): void {
    this.flight = null;
    this.autoFit = false;
    if (animate) {
      this.fly({
        position: new Vector3().fromArray(view.position),
        target: new Vector3().fromArray(view.target),
      });
      return;
    }
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);
    this.allowPose(this.camera.position, this.controls.target);
    this.controls.update();
    this.need = true;
  }

  setViewPreset(preset: ViewPreset | 'home'): void {
    const sphere = this.contentSphere();
    if (!sphere) return;
    const pose = poseForPreset(
      preset === 'home' ? 'iso' : preset,
      sphere,
      this.camera.fov,
      this.aspect,
      preset === 'home' || preset === 'iso' ? HOME_MARGIN : undefined,
    );
    this.autoFit = false;
    this.fly(pose);
  }

  /* ----------------------------------------------------------------------- loop */

  private get aspect() {
    return this.width > 0 && this.height > 0 ? this.width / this.height : 1;
  }

  private readonly loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastNow ? now - this.lastNow : 16;
    this.lastNow = now;
    if (this.flight) this.stepFlight(now);
    this.controls.dampingFactor = dampingFor(dt);
    if (this.controls.update()) this.need = true;
    // animated water and a pending sky light map draw at their own idle rate
    if (this.env.wantsFrame(now)) this.need = true;
    if (!this.need && this.holders.size === 0) return;
    this.need = false;
    this.renderNow(dt, now);
  };

  /** Render immediately (also used by resize so the canvas is never left blank). */
  renderNow(dtMs = 0, now = performance.now()): void {
    if (this.disposed || this.width < 1 || this.height < 1) return;
    for (const cb of this.frameCbs) cb(dtMs);
    const t = performance.now();
    if (this.maskDirty) this.buildLandMask();
    if (this.env.update(this.camera, this.controls.target, (t - this.t0) / 1000, now))
      this.shadowDirty = true;
    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    // one frame's counters across every render call (the point-cloud EDL pass renders inside)
    const info = this.renderer.info as Partial<WebGLRenderer['info']>;
    info.reset?.();
    this.renderer.render(this.scene, this.camera);
    this.lastRenderMs = performance.now() - t;
    this.overlay.update(
      this.camera,
      this.width,
      this.height,
      headingDeg(this.camera.position, this.controls.target),
    );
    if (this.perfHold) {
      this.stats.tick(now);
      if (now - this.gpuAt > 500) {
        this.gpuAt = now;
        this.gpuBytes = estimateGpuBytes([this.scene]) + this.targetBytes();
      }
      this.overlay.setPerf(formatPerf(this.perfStats()));
    }
  }

  /**
   * Estimated GPU memory now (geometry, textures, render targets), bytes. Walks the scene, so
   * callers poll it every few seconds, not every frame.
   */
  memoryEstimate(): number {
    return estimateGpuBytes([this.scene]) + this.targetBytes();
  }

  /** True between a lost WebGL context and its restore (nothing draws meanwhile). */
  get contextLost(): boolean {
    return this.lost;
  }

  // three.js keeps the context restorable (it prevents the default) and re-uploads every
  // buffer and texture from its CPU copy on restore; the stage redraws its derived targets.
  private readonly onContextLost = () => {
    if (this.disposed) return;
    this.lost = true;
    engineConfig().onGpuEvent?.({ type: 'context-lost' });
  };

  private readonly onContextRestored = () => {
    if (this.disposed) return;
    this.lost = false;
    this.shadowDirty = true;
    if (this.env.waterY !== null) this.maskDirty = true;
    this.need = true;
    engineConfig().onGpuEvent?.({ type: 'context-restored' });
  };

  /** Frame statistics while the perf HUD is on (Ctrl+Shift+F); zeros otherwise. */
  perfStats(): PerfStats {
    const r = (this.renderer.info as Partial<WebGLRenderer['info']>).render;
    return {
      fps: this.stats.fps(),
      p50: this.stats.percentileMs(50),
      p95: this.stats.percentileMs(95),
      frames: this.stats.count(),
      points: r?.points ?? 0,
      calls: r?.calls ?? 0,
      triangles: r?.triangles ?? 0,
      gpuBytes: this.gpuBytes,
      cpuMs: this.lastRenderMs,
    };
  }

  /** Drawing buffer (colour, depth, 4x MSAA where on) and the sun's shadow map, bytes. */
  private targetBytes(): number {
    const pr = this.renderer.getPixelRatio();
    const px = this.width * pr * this.height * pr;
    const shadow = this.env.shadowMapSize ** 2 * 4;
    const attrs = (this.renderer as Partial<WebGLRenderer>).getContext?.().getContextAttributes();
    const msaa = attrs?.antialias === false ? 1 : 5;
    return px * 8 * msaa + shadow;
  }

  get quality(): StageQuality {
    return { ...this._quality };
  }

  /** Pixel ratio cap and shadow map size (the graphics quality preset). */
  setQuality(q: Partial<StageQuality>): void {
    this._quality = { ...this._quality, ...q };
    const pr = Math.min(window.devicePixelRatio || 1, this._quality.maxPixelRatio);
    if (pr !== this.renderer.getPixelRatio() || q.maxPixelRatio !== undefined) {
      this.renderer.setPixelRatio(pr);
      if (this.width > 0 && this.height > 0) this.resize(this.width, this.height);
    }
    if (this.env.setQuality(this.envQuality())) this.shadowDirty = true;
    this.need = true;
  }

  private envQuality() {
    const q = this._quality;
    return {
      shadowMapSize: q.shadowMapSize,
      shadowSoftness: q.shadowSoftness,
      water: q.water,
      waterFps: q.waterFps,
      maskSize: q.water === 'full' ? 2048 : 1024,
    };
  }

  /* ----------------------------------------------------------------------- environment */

  get environment(): EnvironmentInfo {
    const d = this.env.lightDirection;
    return {
      ...this.envSettings,
      location: this.location,
      sun: { ...this.sunPos, direction: [...this.sunPos.direction] },
      lightDirection: [d.x, d.y, d.z],
      dataWaterLevel: this.dataWaterLevel,
      waterShown: this.env.waterY !== null,
      night: this.env.daylight?.night ?? 0,
    };
  }

  setEnvironment(patch: Partial<EnvironmentSettings>): void {
    const next = { ...this.envSettings };
    if (patch.mode === 'sky' || patch.mode === 'studio') next.mode = patch.mode;
    if (patch.timeMs !== undefined && Number.isFinite(patch.timeMs)) next.timeMs = patch.timeMs;
    if (patch.water !== undefined) next.water = patch.water;
    if (patch.waterLevel !== undefined)
      next.waterLevel =
        patch.waterLevel !== null && Number.isFinite(patch.waterLevel) ? patch.waterLevel : null;
    this.envSettings = next;
    this.applyEnvironment();
    this.emitState();
  }

  /** Sun from the project's location and time; backdrop; water. */
  private applyEnvironment() {
    const s = this.envSettings;
    this.env.setMode(s.mode);
    const loc = this.location;
    const pos = loc
      ? solarPosition(s.timeMs, loc.lat, loc.lon)
      : { azimuthDeg: 135, elevationDeg: 45 };
    const dir = skyDirection(pos.azimuthDeg, pos.elevationDeg, loc?.convergenceDeg ?? 0);
    this.sunPos = { ...pos, direction: dir };
    this.env.setSun(new Vector3(...dir), pos.elevationDeg);
    this.applyWater();
    this.shadowDirty = true;
    this.need = true;
  }

  private applyWater() {
    const s = this.envSettings;
    const level = s.waterLevel ?? this.dataWaterLevel;
    const show = s.water && level !== null;
    const before = this.env.waterY;
    this.env.setWater(show ? level : null);
    if (!show) this.env.setMaskOn(false);
    else if (before !== level) this.maskDirty = true;
    this.need = true;
  }

  /**
   * Cut the photographed sea out of the ground imagery: a top-down mask of the land meshes
   * (the plant model) above the water, over the extent of the visible rasters.
   */
  private buildLandMask() {
    this.maskDirty = false;
    const level = this.env.waterY;
    if (level === null) return;
    const rasters = new Box3();
    const land = new Box3();
    const tmp = new Box3();
    for (const [root] of this.targets) {
      if (!visibleChain(root)) continue;
      if (root.userData.aioRaster === true) rasters.union(tmp.setFromObject(root));
      else if (root.userData.aioLandMask === true) land.union(tmp.setFromObject(root));
    }
    if (rasters.isEmpty()) {
      this.env.setMaskOn(false);
      return;
    }
    // The photo is flat at the raster height: it stands for ground near that height only. Slopes
    // below it (revetments, quay walls) are drawn by the model and the clouds, not the photo.
    const ok = this.env.renderLandMask(
      { minX: rasters.min.x, maxX: rasters.max.x, minZ: rasters.min.z, maxZ: rasters.max.z },
      Math.max(land.max.y, rasters.max.y, level) + 5,
      Math.max(level + 0.3, rasters.min.y - 1.5),
    );
    this.env.setMaskOn(ok);
  }

  /** Shared uniforms for ground imagery (raster adapter): daylight, shadows, land mask. */
  groundUniforms(): GroundUniforms {
    return this.env.groundUniforms;
  }

  private resize(w: number, h: number) {
    if (w < 1 || h < 1) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.highlight.setResolution(w * pr, h * pr);
    this.renderNow();
  }

  /* ----------------------------------------------------------------------- workspace */

  private readonly onStore = (s: Workspace, prev: Workspace) => {
    if (
      s.project !== prev.project &&
      s.project &&
      this.sync &&
      this.project?.id === s.project.id &&
      this.project.root === s.project.root
    ) {
      // Same project, edited manifest (import, alignment): only changed layers reload.
      this.project = s.project;
      this.sync.sync(s.project.manifest.layers, s.hidden);
    } else if (s.project !== prev.project) this.openProject(s.project);
    else if (s.hidden !== prev.hidden && s.project) {
      this.sync?.sync(s.project.manifest.layers, s.hidden);
      // shown or hidden layers change the land mask and what casts shadows
      if (this.env.waterY !== null) this.maskDirty = true;
      this.shadowDirty = true;
    }
    if (s.selection !== prev.selection) this.applySelection(s.selection);
    if (s.camera && s.camera !== prev.camera) this.handleCamera(s.camera);
  };

  private openProject(project: OpenProject | null) {
    if (project === this.project && this.sync) return;
    this.sync?.dispose();
    this.sync = null;
    this.project = project;
    this.highlight.set('select', null);
    this.highlight.set('hover', null);
    this.clearMeasure();
    this.flight = null;
    this.autoFit = true;
    this.pendingCamera = null;
    this.pendingSelection = null;
    this.dataWaterLevel = null;
    this.location = project ? siteLocation(project.manifest) : null;
    if (project) this.envSettings = defaultEnvironment(project.manifest, Date.now());
    this.applyEnvironment();
    this.emitState();
    if (project) {
      const sync = new LayerSync({
        getAdapter: this.getAdapter,
        ctx: { url: (ref) => this.opts.resolveUrl(project.id, ref), scene: this },
        onLoaded: () => {
          this.contentChanged();
        },
        onError: (layer, e) => {
          console.error(`Layer "${layer.name}" could not be loaded`, e);
        },
        onMissing: (layer) => {
          if (this.warnedKinds.has(layer.kind)) return;
          this.warnedKinds.add(layer.kind);
          console.warn(`No adapter for ${layer.kind} layers yet; "${layer.name}" is skipped`);
        },
      });
      this.sync = sync;
      sync.sync(project.manifest.layers, this.opts.store.getState().hidden);
    }
    this.contentChanged();
  }

  /** Called when layers load, unload or change visibility. */
  private contentChanged() {
    const box = this.contentBox();
    let terrain = false;
    for (const [root] of this.targets) {
      if (root.userData.aioRaster === true && visibleChain(root)) terrain = true;
      else
        root.traverse((o) => {
          if (!terrain && o.userData.type === 'terrain' && visibleChain(o)) terrain = true;
        });
    }
    this.env.setGroundVisible(!terrain);
    if (!box.isEmpty()) {
      const centre = box.getCenter(new Vector3());
      const radius = box.getSize(new Vector3()).length() / 2;
      this.contentCentre.copy(centre);
      this.env.setContentRadius(radius, centre);
      // shadows fall from the content onto the ground and the water below it
      const sb = box.clone();
      sb.min.y = Math.min(sb.min.y, 0, this.env.waterY ?? 0);
      this.env.setShadowBounds(sb);
      if (this.env.waterY !== null) this.maskDirty = true;
      this.controls.minDistance = Math.max(radius * 0.002, 0.05);
      this.controls.maxDistance = radius * 25;
      applySection(this.clippingPlanes, this._section, this.contentCentre);
      if (this.autoFit) {
        const pose = poseForPreset(
          'iso',
          { center: centre, radius },
          this.camera.fov,
          this.aspect,
          HOME_MARGIN,
        );
        this.camera.position.copy(pose.position);
        this.controls.target.copy(pose.target);
        this.controls.update();
      }
    }
    if (this.pendingSelection) this.applySelection(this.pendingSelection);
    if (this.pendingCamera) this.handleCamera(this.pendingCamera);
    this.rebuildCallouts();
    this.shadowDirty = true;
    this.need = true;
  }

  private contentBox(): Box3 {
    const box = new Box3();
    const tmp = new Box3();
    for (const [root] of this.targets) {
      if (!visibleChain(root)) continue;
      if (root.userData.aioRaster === true) continue; // ground imagery does not drive framing
      expandWithoutTerrain(root, box, tmp);
    }
    if (box.isEmpty()) {
      for (const [root] of this.targets) if (visibleChain(root)) box.union(tmp.setFromObject(root));
    }
    return box;
  }

  contentBounds(): Box3 | null {
    const box = this.contentBox();
    return box.isEmpty() ? null : box;
  }

  private contentSphere(): { center: Vector3; radius: number } | null {
    const box = this.contentBox();
    if (box.isEmpty()) return null;
    return {
      center: box.getCenter(new Vector3()),
      radius: box.getSize(new Vector3()).length() / 2,
    };
  }

  /** Water level of a modelled sea (local y), set by the mesh adapter; null when it goes. */
  setWaterLevel(level: number | null): void {
    if (level === this.dataWaterLevel) return;
    this.dataWaterLevel = level;
    this.applyWater();
    this.shadowDirty = true;
    this.emitState();
  }

  /** Redraw the shadow map on the next frame (content moved or changed visibility). */
  invalidateShadows(): void {
    this.shadowDirty = true;
    this.need = true;
  }

  private findNode(id: string, layerId?: string) {
    for (const [root, lid] of this.targets) {
      if (layerId && lid !== layerId) continue;
      const node = root.name === id ? root : root.getObjectByName(id);
      if (node) return { node, root, layerId: lid };
    }
    return null;
  }

  private applySelection(sel: Selection | null) {
    this.pendingSelection = null;
    if (sel?.kind !== 'asset') {
      if (this.highlight.set('select', null)) this.rebuildCallouts();
      this.need = true;
      return;
    }
    const hit = this.findNode(sel.id, sel.layer);
    if (!hit) {
      this.pendingSelection = sel;
      this.highlight.set('select', null);
    } else this.highlight.set('select', hit.node);
    this.rebuildCallouts();
    this.need = true;
  }

  private handleCamera(req: CameraRequest) {
    const store = this.opts.store.getState();
    const current: CameraPose = { position: this.camera.position, target: this.controls.target };
    const t = req.target;
    let pose: CameraPose | null = null;
    if (t.kind === 'home') {
      const sphere = this.contentSphere();
      if (sphere) pose = poseForPreset('iso', sphere, this.camera.fov, this.aspect, HOME_MARGIN);
    } else if (t.kind === 'point') {
      pose = poseForPoint(
        new Vector3(...t.p),
        current,
        t.distance,
        t.dir ? new Vector3(...t.dir) : undefined,
      );
    } else {
      const hit =
        t.selection.kind === 'asset' ? this.findNode(t.selection.id, t.selection.layer) : null;
      if (hit)
        pose = frameBox(new Box3().setFromObject(hit.node), current, this.camera.fov, this.aspect);
    }
    if (!pose) {
      // wait for layers still loading; give up when nothing is pending
      this.pendingCamera = this.sync && this.sync.pendingCount() > 0 ? req : null;
      if (!this.pendingCamera) store.consumeCamera(req.seq);
      return;
    }
    this.pendingCamera = null;
    this.autoFit = false;
    this.fly(pose);
    store.consumeCamera(req.seq);
  }

  /**
   * Let the orbit reach a pose that looks up (a photo taken inside a tank, looking at the roof):
   * the limit opens to that pose's angle until the next flight or restored view.
   */
  private allowPose(position: Vector3, target: Vector3) {
    const d = position.clone().sub(target);
    const polar = Math.acos(Math.min(1, Math.max(-1, d.y / Math.max(d.length(), 1e-9))));
    this.controls.maxPolarAngle = Math.max(MAX_POLAR, Math.min(Math.PI, polar + 0.01));
  }

  private fly(to: CameraPose) {
    const ms = reducedMotion() ? 0 : FLY_MS;
    this.allowPose(to.position, to.target);
    const from = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    this.flight = {
      from,
      to: { position: to.position.clone(), target: to.target.clone() },
      start: performance.now(),
      ms,
    };
    if (ms === 0) this.stepFlight(performance.now());
    this.need = true;
  }

  private stepFlight(now: number) {
    const f = this.flight;
    if (!f) return;
    const k = f.ms > 0 ? easeInOutCubic((now - f.start) / f.ms) : 1;
    this.camera.position.lerpVectors(f.from.position, f.to.position, k);
    this.controls.target.lerpVectors(f.from.target, f.to.target, k);
    if (k >= 1) this.flight = null;
    this.need = true;
  }

  /* ----------------------------------------------------------------------- callouts */

  private anchorOf(node: Object3D): Vector3 {
    let a = this.anchors.get(node);
    if (!a) {
      const b = new Box3().setFromObject(node);
      a = b.isEmpty()
        ? node.getWorldPosition(new Vector3())
        : new Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
      this.anchors.set(node, a);
    }
    return a;
  }

  /** Visible bounding-box volume, to pick the most prominent component of a group. */
  private volumeOf(node: Object3D): number {
    let v = this.volumes.get(node);
    if (v === undefined) {
      const size = new Box3().setFromObject(node).getSize(new Vector3());
      v = Math.max(size.x, 1e-3) * Math.max(size.y, 1e-3) * Math.max(size.z, 1e-3);
      this.volumes.set(node, v);
    }
    return v;
  }

  private nodeIn(root: Object3D, name: string): Object3D | null {
    let cache = this.nodeCache.get(root);
    if (!cache) {
      cache = new Map();
      this.nodeCache.set(root, cache);
    }
    let node = cache.get(name);
    if (node === undefined) {
      node = root.name === name ? root : (root.getObjectByName(name) ?? null);
      cache.set(name, node);
    }
    return node;
  }

  /** Title and detail lines for a component, from the manifest tag or the glTF extras. */
  private describe(node: Object3D): string[] {
    const ud = node.userData as { tag?: unknown; type?: unknown };
    let manifestTag: AssetTag | undefined;
    for (const [root] of this.targets)
      manifestTag ??= ((root.userData.aioTags ?? []) as AssetTag[]).find(
        (t) => t.node === node.name,
      );
    const title = manifestTag?.tag ?? (typeof ud.tag === 'string' ? ud.tag : node.name);
    const detail =
      extrasName(node) ??
      manifestTag?.area ??
      (typeof ud.type === 'string' ? ud.type.replace(/_/g, ' ') : '');
    return detail ? [title, detail] : [title];
  }

  private frameNodes(nodes: readonly Object3D[]) {
    const box = new Box3();
    for (const n of nodes) box.expandByObject(n);
    const pose = frameBox(
      box,
      { position: this.camera.position, target: this.controls.target },
      this.camera.fov,
      this.aspect,
    );
    if (!pose) return;
    this.autoFit = false;
    this.fly(pose);
  }

  /**
   * Callouts for the label mode: the selected and hovered component always; in `key` mode one
   * callout per component group (its most prominent member); in `all` mode every tagged component.
   */
  private rebuildCallouts() {
    const specs: CalloutSpec[] = [];
    const selected = this.highlight.selected;
    const hovered = this.highlight.hovered;
    const mode = this._labelMode;
    const groups = new Map<string, { nodes: Object3D[]; tags: AssetTag[] }>();
    let hoverListed = false;
    for (const [root] of this.targets) {
      if (!visibleChain(root)) continue;
      const tags = (root.userData.aioTags ?? []) as AssetTag[];
      for (const t of tags) {
        const node = this.nodeIn(root, t.node);
        if (!node || !visibleChain(node)) continue;
        if (mode === 'key' && t.area) {
          const g = groups.get(t.area) ?? { nodes: [], tags: [] };
          g.nodes.push(node);
          g.tags.push(t);
          groups.set(t.area, g);
        }
        if (node === selected) continue;
        const isHover = node === hovered;
        if (mode !== 'all' && !isHover) continue;
        if (isHover) hoverListed = true;
        const detail = extrasName(node) ?? t.area ?? '';
        specs.push({
          id: t.node,
          anchor: this.anchorOf(node),
          lines: detail ? [t.tag, detail] : [t.tag],
          selected: false,
          forced: isHover,
        });
      }
    }
    this.groupNodes.clear();
    for (const [area, g] of groups) {
      const only = g.nodes.length === 1 ? g.nodes[0] : undefined;
      const onlyTag = g.tags[0];
      if (only && onlyTag) {
        if (only === selected || only === hovered) continue;
        specs.push({
          id: onlyTag.node,
          anchor: this.anchorOf(only),
          lines: [onlyTag.tag, groupLabel(area)],
          selected: false,
          rank: 1,
        });
        continue;
      }
      let rep = g.nodes[0];
      for (const n of g.nodes) if (rep && this.volumeOf(n) > this.volumeOf(rep)) rep = n;
      if (!rep) continue;
      const id = `group:${area}`;
      this.groupNodes.set(id, g.nodes);
      specs.push({
        id,
        anchor: this.anchorOf(rep),
        lines: [groupLabel(area), `${g.nodes.length} components`],
        selected: false,
        rank: 1,
      });
    }
    if (hovered && hovered !== selected && !hoverListed)
      specs.push({
        id: hovered.name,
        anchor: this.anchorOf(hovered),
        lines: this.describe(hovered),
        selected: false,
        forced: true,
      });
    if (selected)
      specs.push({
        id: selected.name,
        anchor: this.anchorOf(selected),
        lines: this.describe(selected),
        selected: true,
      });
    this.overlay.setCallouts(specs);
  }

  /* ----------------------------------------------------------------------- picking */

  private intersect(ndcX: number, ndcY: number): Intersection[] {
    this.raycaster.setFromCamera(this.ndc.set(ndcX, ndcY), this.camera);
    this.raycaster.layers.mask = 1 | (1 << PICK_LAYER);
    const hits: Intersection[] = [];
    for (const [root] of this.targets) {
      if (!visibleChain(root)) continue;
      this.raycaster.intersectObject(root, true, hits);
    }
    const planes = this.clippingPlanes;
    return hits
      .filter((h) => visibleChain(h.object) && planes.every((p) => p.distanceToPoint(h.point) >= 0))
      .sort((a, b) => a.distance - b.distance);
  }

  private rootOf(o: Object3D): [Object3D, string] | null {
    for (let p: Object3D | null = o; p; p = p.parent) {
      const lid = this.targets.get(p);
      if (lid !== undefined) return [p, lid];
    }
    return null;
  }

  private isUnder(node: Object3D, root: Object3D) {
    for (let p: Object3D | null = node; p; p = p.parent) if (p === root) return true;
    return false;
  }

  /** The selectable node under a screen point, or null. */
  pick(ndcX: number, ndcY: number): { node: Object3D; layerId: string } | null {
    for (const h of this.intersect(ndcX, ndcY)) {
      const owner = this.rootOf(h.object);
      if (!owner) continue;
      const [root, layerId] = owner;
      const tagged = (root.userData.aioTagged ?? new Set<string>()) as Set<string>;
      const node = selectableNode(h.object, root, tagged);
      return node ? { node, layerId } : null;
    }
    return null;
  }

  private toNdc(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.downAt = [e.clientX, e.clientY];
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const d = this.downAt;
    this.downAt = null;
    if (!d || e.button !== 0) return;
    const slop = e.pointerType === 'touch' ? 12 : CLICK_SLOP_PX;
    if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > slop) return;
    for (const claim of this.clickClaims) if (claim(e)) return;
    const [x, y] = this.toNdc(e);
    if (this._tool === 'measure') {
      const hit = this.raycast(x, y);
      if (!hit) return;
      this.measureTool.add(hit.point);
      this.overlay.setMeasure(this.measureTool.a, this.measureTool.b, this.measureTool.label());
      this.need = true;
      return;
    }
    const picked = this.pick(x, y);
    this.opts.store
      .getState()
      .select(picked ? { kind: 'asset', id: picked.node.name, layer: picked.layerId } : null);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    this.hoverEvent = e;
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const ev = this.hoverEvent;
      if (!ev || this.disposed) return;
      const [x, y] = this.toNdc(ev);
      const node = this._tool === 'measure' ? null : (this.pick(x, y)?.node ?? null);
      if (this.highlight.set('hover', node)) {
        this.need = true;
        this.rebuildCallouts();
      }
      this.canvas.style.cursor = this._tool === 'measure' ? 'crosshair' : node ? 'pointer' : '';
    });
  };

  private readonly onPointerLeave = () => {
    this.hoverEvent = null;
    if (this.highlight.set('hover', null)) {
      this.need = true;
      this.rebuildCallouts();
    }
  };

  private readonly onKey = (e: KeyboardEvent) => {
    // Ctrl+Shift+F, Cmd+Shift+F on macOS
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      this.setPerfOverlay(this.perfHold === null);
      return;
    }
    if (e.key === 'Escape' && this._tool === 'measure') this.clearMeasure();
  };

  /* ----------------------------------------------------------------------- misc */

  /** While a section is on, show back faces so cut solids read as shells; restore after. */
  private applySectionSide(mesh: Mesh) {
    const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.userData.aioKeepSide === true) continue;
      m.userData.aioBaseSide ??= m.side;
      const side = this._section.enabled ? DoubleSide : (m.userData.aioBaseSide as Side);
      if (m.side === side) continue;
      m.side = side;
      m.needsUpdate = true;
    }
  }

  private emitState() {
    for (const cb of this.stateCbs) cb();
  }

  /**
   * OrbitControls takes its keydown listener off `canvas.getRootNode()` when it is disposed. React
   * detaches the view before its effects clean up, so by then that is the detached subtree, not the
   * document the listener was added to: the listener stayed, and with it this stage, its renderer
   * and the whole detached workspace DOM (the maps and their WebGL contexts), one set per project
   * opened (T8 soak, 6 MB of renderer heap per project switch). Dispose against the root it used.
   */
  private disposeControls(): void {
    const root = this.controlsRoot;
    Object.defineProperty(this.canvas, 'getRootNode', { value: () => root, configurable: true });
    try {
      this.controls.dispose();
    } finally {
      Reflect.deleteProperty(this.canvas, 'getRootNode');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // read before the scene is torn down: the renderer's uniforms name them
    const shared = moduleTextures(this.renderer, this.scene);
    cancelAnimationFrame(this.raf);
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.ro.disconnect();
    this.unsubscribe();
    this.sync?.dispose();
    this.sync = null;
    window.removeEventListener('keydown', this.onKey);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.disposeControls();
    this.overlay.dispose();
    this.highlight.dispose();
    this.measureTool.dispose();
    this.env.dispose();
    this.renderer.dispose();
    // three's module-level textures would keep this renderer (and its canvas) alive otherwise
    for (const t of shared) t.dispose();
    // Geometry and textures shared with another stage (comparing dates) still hold this
    // renderer's dispose listeners; losing the context frees its GPU copies now.
    (this.renderer as Partial<WebGLRenderer>).forceContextLoss?.();
    this.canvas.remove();
    this.frameCbs.clear();
    this.providers.clear();
    this.holders.clear();
    this.stateCbs.clear();
  }
}
