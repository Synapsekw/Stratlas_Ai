import type { AssetRef, Layer, LayerKind } from '@aio/schema';
import type {
  Box3,
  Intersection,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Plane,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ViewPreset } from './camera/cameraMath';
import type { StageQuality } from './config';
import type { EnvironmentSettings, SiteLocation } from './stage/envDefaults';
import type { EnvironmentMode } from './stage/environment';
import type { PerfStats } from './stage/perf';
import type { SectionState } from './tools/section';

export type { EnvironmentMode, EnvironmentSettings, PerfStats, SiteLocation, StageQuality };

/** The stage environment now: the settings plus what follows from them. */
export interface EnvironmentInfo extends EnvironmentSettings {
  /** The project's place on the Earth; null without a geographic origin (no sun position). */
  location: SiteLocation | null;
  /** Sun position for `timeMs` at `location` (a fixed studio light when location is null). */
  sun: {
    azimuthDeg: number;
    elevationDeg: number;
    /** Unit vector toward the sun, local frame (x east, y up, z south). */
    direction: [number, number, number];
  };
  /** Unit vector toward the light that casts shadows now: the sun, the moon or the studio lamp. */
  lightDirection: [number, number, number];
  /** Sea level found in the project data (local y), or null. */
  dataWaterLevel: number | null;
  /** Water is drawn now (toggle on and a level known). */
  waterShown: boolean;
  /** 0 by day, 1 by night (sky mode). */
  night: number;
}

/** A rendering surface the app mounts into a panel. */
export interface Viewport {
  mount(el: HTMLElement): void;
  setLayers(layers: readonly Layer[]): void;
  /** Called by the panel's ResizeObserver; must redraw immediately. */
  resize(width: number, height: number): void;
  dispose(): void;
}

/**
 * The live scene, owned by SceneView (stream S3) and shared with adapters and tools from other
 * streams (point clouds, video projection, annotation). All coordinates are in the local frame of
 * docs/architecture/data-conventions.md (Y up, X east, Z south, metres).
 */
export interface SceneHandle {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly projectId: string;
  /** Ask for a redraw on the next animation frame (render on demand). */
  requestRender(): void;
  /** Run a callback before every rendered frame; returns an unsubscribe function. */
  onFrame(cb: (dtMs: number) => void): () => void;
  /** Keep rendering every frame while at least one holder is active (video playing, animations). */
  holdContinuous(reason: string): () => void;
  /** Meshes that receive projected video (mesh layers and the ground). */
  projectionReceivers(): readonly Mesh[];
  /** Raycast from normalised device coordinates against meshes, ground and point clouds. */
  raycast(ndcX: number, ndcY: number): Intersection | null;
  /**
   * Cast a world-space ray (camera poses of photos and video frames) against visible content,
   * then the ground plane y = 0. Section planes are ignored: the camera saw the real asset.
   * Mesh hits name their layer through `userData.layerId` on the layer root.
   */
  raycastRay(origin: Vector3, dir: Vector3): Intersection | null;
  /**
   * Add a picker that `raycast` consults besides meshes (point clouds); the nearest hit wins.
   * Returns an unsubscribe function.
   */
  addRaycastProvider(provider: RaycastProvider): () => void;
  /**
   * Section planes shared by every layer. Assign this exact array to `material.clippingPlanes`
   * (and set `clipShadows`) so the section tool cuts meshes and clouds together. The engine
   * mutates it in place; three.js recompiles when its length changes.
   */
  readonly clippingPlanes: Plane[];
  /** Register content for `raycast` and "fit all" (mesh roots, raster quads, clouds). */
  addRaycastTarget(object: Object3D, layerId: string): () => void;
  /** Register a mesh that should receive projected video. */
  addProjectionReceiver(mesh: Mesh): () => void;
}

/** Extra content for `SceneHandle.raycast`, e.g. point picking within a few pixels. */
export type RaycastProvider = (ndcX: number, ndcY: number) => Intersection | null;

export type StageTool = 'select' | 'measure' | 'section';

/**
 * Component callouts: `off` shows only the selected and hovered component, `key` adds one callout
 * per component group (manifest tag `area`), `all` labels every tagged component.
 */
export type LabelMode = 'off' | 'key' | 'all';

/** A client-space rectangle, as returned by getBoundingClientRect. */
export interface ClientRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Camera position and orbit target in the local frame, for saving and restoring a view. */
export interface SavedView {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * The full 3D stage behind SceneView: everything in SceneHandle plus the controls the UI drives
 * (view presets, tools, section). Get it with `getActiveStage()`.
 */
export interface EngineStage extends SceneHandle {
  readonly controls: OrbitControls;
  setViewPreset(preset: ViewPreset | 'home'): void;
  readonly tool: StageTool;
  setTool(tool: StageTool): void;
  readonly section: SectionState;
  setSection(patch: Partial<SectionState>): void;
  /** The point section offsets are measured from (centre of the visible content). */
  sectionOrigin(): Vector3;
  clearMeasure(): void;
  /**
   * Let an overlay take a left click on the stage before the stage selects or measures (section
   * points, boundary editing). The handler gets the pointer-up of a click that did not drag;
   * returning true means the stage ignores that click. Returns an unsubscribe. Overlays must claim
   * clicks here rather than stop the pointer events: the orbit controls need every release, or
   * they keep rotating with the mouse.
   */
  claimClicks(handler: (e: PointerEvent) => boolean): () => void;
  readonly labelMode: LabelMode;
  setLabelMode(mode: LabelMode): void;
  /**
   * UI drawn over the stage (video window, toolbars). Callout dots, leaders and plates keep clear
   * of these rectangles, read after every rendered frame.
   */
  setLabelKeepOut(provider: (() => Iterable<ClientRectLike>) | null): void;
  /** The client rects of that UI right now, for HTML drawn on the stage (panorama view). */
  uiKeepOut(): ClientRectLike[];
  /** World points (issue pins) that callout plates must not cover. Returns an unsubscribe. */
  addLabelObstacles(provider: () => Iterable<Vector3>): () => void;
  /**
   * Bounds of the visible content in the local frame (what Home frames: models, clouds, without
   * ground imagery or modelled terrain), or null while nothing has loaded.
   */
  contentBounds(): Box3 | null;
  /** The current view, to restore when the stage is created again. */
  saveView(): SavedView;
  /** Jump (or fly) to a saved view; the stage no longer frames content as it loads. */
  restoreView(view: SavedView, animate?: boolean): void;
  /** The perf HUD: fps, frame time p50/p95, points, draw calls, GPU memory (also Ctrl+Shift+F). */
  setPerfOverlay(on: boolean): void;
  /** What the perf HUD shows; frame times are only collected while it is on. */
  perfStats(): PerfStats;
  /** Estimated GPU memory now, bytes (walks the scene: poll it every few seconds). */
  memoryEstimate(): number;
  /** True while the WebGL context is lost (GPU reset or out of memory), until it is restored. */
  readonly contextLost: boolean;
  /** Pixel ratio cap, shadow and water detail of the graphics quality preset. */
  readonly quality: StageQuality;
  setQuality(q: Partial<StageQuality>): void;
  /**
   * Backdrop, sun and water: sky or studio, the instant the sun is computed for (from the
   * project's location), the water toggle and level. Starts from `defaultEnvironment(manifest)`
   * on every project open; the app re-applies the user's per-project choice.
   */
  readonly environment: EnvironmentInfo;
  setEnvironment(patch: Partial<EnvironmentSettings>): void;
  /** Listen for tool or section changes, for toolbar state. */
  onStateChange(cb: () => void): () => void;
}

export interface AdapterContext {
  /** Resolve an asset reference to a fetchable aio:// URL. */
  url(ref: AssetRef): string;
  scene: SceneHandle;
}

export interface LayerHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Turns one kind of layer into scene objects. Each stream registers its adapter. */
export interface LayerAdapter<K extends LayerKind = LayerKind> {
  kind: K;
  create(layer: Extract<Layer, { kind: K }>, ctx: AdapterContext): Promise<LayerHandle>;
}
