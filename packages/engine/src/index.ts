import type { AssetRef, Layer, LayerKind } from '@aio/schema';

/** A rendering surface the app mounts into a panel. */
export interface Viewport {
  mount(el: HTMLElement): void;
  setLayers(layers: readonly Layer[]): void;
  /** Called by the panel's ResizeObserver; must redraw immediately. */
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface AdapterContext {
  /** Resolve an asset reference to a fetchable aio:// URL. */
  url(ref: AssetRef): string;
  requestRender(): void;
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
