import type { LayerKind } from '@aio/schema';
import type { EngineStage, LayerAdapter, SceneHandle } from './types';

const adapters = new Map<LayerKind, LayerAdapter>();

export function registerAdapter<K extends LayerKind>(adapter: LayerAdapter<K>): void {
  if (adapters.has(adapter.kind)) {
    throw new Error(`An adapter for "${adapter.kind}" layers is already registered`);
  }
  // Stored type-erased; getAdapter(kind) only ever hands it layers of its own kind.
  adapters.set(adapter.kind, adapter as unknown as LayerAdapter);
}

export function getAdapter(kind: LayerKind): LayerAdapter | undefined {
  return adapters.get(kind);
}

/** Test helper. */
export function clearAdapters(): void {
  adapters.clear();
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

/** The active stage with its UI controls (view presets, tools, section), if SceneView is mounted. */
export function getActiveStage(): EngineStage | null {
  return active && isEngineStage(active) ? active : null;
}

export function isEngineStage(h: SceneHandle): h is EngineStage {
  return 'setViewPreset' in h && 'setTool' in h;
}

export function onActiveScene(listener: (h: SceneHandle | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
