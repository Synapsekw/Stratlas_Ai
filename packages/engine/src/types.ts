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
  /**
   * Register content for `raycast` and "fit all" (mesh roots, raster quads, clouds). A root with
   * `userData.aioGround` stands in for the ground (the street map drape): it hides the plain
   * ground while visible and never drives framing.
   */
  addRaycastTarget(object: Object3D, layerId: string): () => void;
  /**
   * Register content that frames the view without being pickable (flight paths, photo places):
   * auto-fit as layers load and Home use it when no model or point cloud is visible. `bounds` is
   * read whenever the stage frames, in the local frame; null while hidden or empty. Returns an
   * unsubscribe function. With `always`, the bounds widen the view even while a model or cloud is
   * shown (panorama markers can stand far outside a small model); without it they only count when
   * there is none. With `solid`, the bounds count as content like a model (a point cloud): Home,
   * auto-fit, the shadows and the zoom-out cap include them; return null while hidden. `near` is
   * the part of the content within FAR_M of the origin (photo places a bad GPS put far away left
   * out), framed by Centre on project; without it the bounds count there whole when their centre
   * lies within FAR_M.
   */
  addContentBounds(
    bounds: () => Box3 | null,
    opts?: { always?: boolean; solid?: boolean; near?: () => Box3 | null },
  ): () => void;
  /** Register a mesh that should receive projected video. */
  addProjectionReceiver(mesh: Mesh): () => void;
  /**
   * Compile the shader programs `object` will be drawn with, before it is in the scene, so the
   * frame that first draws it does not wait for the compiler (seconds on a software renderer).
   * Resolves when it can be added or shown; the view keeps drawing meanwhile. Never rejects: on a
   * lost context, a disposed stage or a renderer that cannot say when a program is done it
   * resolves at once and the object compiles in its first frame, as before. Dispose the object's
   * materials yourself if it is dropped while this is pending. A scene without it draws at once.
   */
  compileAhead?(object: Object3D): Promise<void>;
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
   * ground imagery or modelled terrain; without those, flights and photos), or null while nothing
   * has loaded.
   */
  contentBounds(): Box3 | null;
  /**
   * What Centre on project frames, in the local frame: the visible models and clouds; without
   * them the flights and photos within FAR_M of the origin (photo places a bad GPS put far away
   * left out); null when there is neither.
   */
  siteBounds(): Box3 | null;
  /**
   * An extent the camera must be able to back off far enough to see (a walk being placed), under
   * `key`; null removes it. It widens the camera's distance cap only: Home and framing still
   * follow the content.
   */
  setReach(key: string, box: Box3 | null): void;
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
  /** The node under the mouse, with its component record (hover brief). */
  readonly hovered: PickInfo | null;
  /** The selected node as drawn (null while the selection has not loaded or is not an asset). */
  readonly selected: PickInfo | null;
  /** Listen for hover and selection changes of the highlighted node. Returns an unsubscribe. */
  onPick(cb: (e: PickEvent) => void): () => void;
  /** What a click at a normalised device point would select (tests, tools). */
  pickAt(ndcX: number, ndcY: number): PickInfo | null;
  /**
   * Show or hide one node of a layer (component id or node name). False when the layer is not
   * loaded, cannot hide single nodes, or has no such node.
   */
  setNodeVisible(layerId: string, node: string, visible: boolean): boolean;
  /** The engineering components of a loaded layer (empty for other layers). */
  components(layerId: string): ComponentInfo[];
}

export interface AdapterContext {
  /** Resolve an asset reference to a fetchable aio:// URL. */
  url(ref: AssetRef): string;
  scene: SceneHandle;
}

/**
 * The component record of an engineering model node (its glTF extras): what hover briefs and the
 * component panel show.
 */
export interface ComponentInfo {
  id: string;
  name: string;
  category?: string;
  description?: string;
  tag?: string;
  basis?: string;
  /** `draft`, `accepted` or `rejected` (a draft is shown while a model is reviewed). */
  status?: string;
  /** The component id it is mounted on. */
  parent?: string;
  /** Surfaces no evidence saw (`back`, `top`, `interior`, `base`). */
  unobserved?: string[];
  /** How each parameter is known, the worst fit residual and the least coverage. */
  quality?: ComponentQuality;
}

export interface ComponentQuality {
  /** Parameter name to its basis (`measured`, `observed`, `inferred`, `user`). */
  params: Record<string, string>;
  residualM?: number;
  /** 0..1, the share of the surface the evidence covers. */
  coverage?: number;
}

/**
 * A node under the cursor or selected: its selection id (the extras `component` id, else the node
 * name), its layer, and its component record when it has one.
 */
export interface PickInfo {
  node: string;
  layerId: string;
  component?: ComponentInfo;
}

/** A hover or selection change on the stage; `pick` is null when it cleared. */
export interface PickEvent {
  kind: 'hover' | 'select';
  pick: PickInfo | null;
}

export interface LayerHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
  /**
   * Show or hide one node (component id or node name): hidden, it is neither drawn nor picked.
   * Only layers that draw their nodes separately offer it (engineering models).
   */
  setNodeVisible?(node: string, visible: boolean): void;
  /** The engineering components of the layer, in file order. */
  components?(): ComponentInfo[];
}

/** Turns one kind of layer into scene objects. Each stream registers its adapter. */
export interface LayerAdapter<K extends LayerKind = LayerKind> {
  kind: K;
  create(layer: Extract<Layer, { kind: K }>, ctx: AdapterContext): Promise<LayerHandle>;
}
