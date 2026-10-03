import type { AssetRef, Layer, LayerKind } from '@aio/schema';
import type { Intersection, Mesh, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

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

const adapters = new Map<LayerKind, LayerAdapter>();

export function registerAdapter(adapter: LayerAdapter): void {
  if (adapters.has(adapter.kind)) {
    throw new Error(`An adapter for "${adapter.kind}" layers is already registered`);
  }
  adapters.set(adapter.kind, adapter);
}

export function getAdapter(kind: LayerKind): LayerAdapter | undefined {
  return adapters.get(kind);
}

/** Test helper. */
export function clearAdapters(): void {
  adapters.clear();
}
export { SceneView, type SceneViewProps } from './SceneView';

/** Registers the mesh (GLB with Meshopt) and image raster adapters. Owner: stream S3. Phase 0: no-op. */
export function registerEngineAdapters(): void {
  /* implemented by stream S3 */
}

let active: SceneHandle | null = null;
const listeners = new Set<(h: SceneHandle | null) => void>();

/** Called by SceneView when its scene is created or disposed. */
export function setActiveScene(handle: SceneHandle | null): void {
  active = handle;
  for (const l of listeners) l(handle);
}

/** The scene currently on screen, for tools that act on it (annotation, agent fly-to). */
export function getActiveScene(): SceneHandle | null {
  return active;
}

export function onActiveScene(listener: (h: SceneHandle | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
