import { shiftedLayer, type Layer, type LayerKind } from '@aio/schema';
import { shiftKey } from '@aio/workspace';
import type { AdapterContext, LayerAdapter, LayerHandle } from '../types';

export interface LayerSyncDeps {
  getAdapter(kind: LayerKind): LayerAdapter | undefined;
  ctx: AdapterContext;
  onLoaded?(layer: Layer, handle: LayerHandle): void;
  onError?(layer: Layer, error: unknown): void;
  /** A layer kind with no registered adapter (another stream has not landed yet). */
  onMissing?(layer: Layer): void;
  onRemoved?(layer: Layer): void;
}

interface Entry {
  /** The layer as drawn: with its date shift applied. */
  layer: Layer;
  key: string;
  handle: LayerHandle | null;
  visible: boolean;
  dead: boolean;
}

/** Stable identity of a layer definition and its date shift; visibility is not part of it. */
function layerKey(layer: Layer, ctx: AdapterContext): string {
  const shift = shiftKey(ctx.shiftOf?.(layer.id) ?? null);
  return JSON.stringify({ ...layer, visible: undefined }) + shift;
}

/**
 * Keeps one adapter handle per manifest layer. Creates new layers, disposes removed or changed
 * ones (including handles that resolve after their layer is gone) and applies visibility live.
 */
export class LayerSync {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly deps: LayerSyncDeps) {}

  sync(layers: readonly Layer[], hidden: Readonly<Record<string, true>>): void {
    if (this.disposed) return;
    const wanted = new Map(layers.map((l) => [l.id, l]));
    for (const [id, e] of this.entries) {
      const next = wanted.get(id);
      if (!next || layerKey(next, this.deps.ctx) !== e.key) this.drop(id, e);
    }
    for (const layer of layers) {
      const visible = !hidden[layer.id];
      const existing = this.entries.get(layer.id);
      if (existing) {
        if (existing.visible !== visible) {
          existing.visible = visible;
          existing.handle?.setVisible(visible);
        }
        continue;
      }
      this.create(layer, visible);
    }
  }

  handle(layerId: string): LayerHandle | undefined {
    return this.entries.get(layerId)?.handle ?? undefined;
  }

  /** The layer as drawn (with its date shift). */
  layer(layerId: string): Layer | undefined {
    return this.entries.get(layerId)?.layer;
  }

  /** Layers whose handles have not arrived yet. */
  pendingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (!e.handle) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, e] of this.entries) this.drop(id, e);
  }

  private create(layer: Layer, visible: boolean): void {
    const adapter = this.deps.getAdapter(layer.kind);
    if (!adapter) {
      this.deps.onMissing?.(layer);
      return;
    }
    const { ctx } = this.deps;
    const drawn = shiftedLayer(layer, ctx.shiftOf?.(layer.id) ?? null);
    const key = layerKey(layer, ctx);
    const entry: Entry = { layer: drawn, key, handle: null, visible, dead: false };
    this.entries.set(layer.id, entry);
    adapter.create(drawn, ctx).then(
      (handle) => {
        if (entry.dead) {
          handle.dispose();
          return;
        }
        entry.handle = handle;
        handle.setVisible(entry.visible);
        this.deps.onLoaded?.(layer, handle);
      },
      (error: unknown) => {
        if (entry.dead) return;
        this.entries.delete(layer.id);
        this.deps.onError?.(layer, error);
      },
    );
  }

  private drop(id: string, e: Entry): void {
    e.dead = true;
    this.entries.delete(id);
    if (e.handle) {
      e.handle.dispose();
      this.deps.onRemoved?.(e.layer);
    }
  }
}
