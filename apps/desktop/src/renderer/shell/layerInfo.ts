import type { LayerInfo } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { bridge } from '../shell';
import { setFileExtentSource } from './appBounds';

let cache = new Map<string, Promise<LayerInfo | null>>();
let cachedFor: unknown = null;

/** `layer:info` for a dataset of the open project, kept until the manifest changes. */
export function readLayerInfo(layerId: string): Promise<LayerInfo | null> {
  const p = workspace.getState().project;
  if (!p) return Promise.resolve(null);
  if (cachedFor !== p.manifest) {
    cache = new Map();
    cachedFor = p.manifest;
  }
  const hit = cache.get(layerId);
  if (hit) return hit;
  const ask: Promise<LayerInfo | null> = bridge
    .call('layer:info', { projectId: p.id, layerId })
    .then((r) => (r.ok && r.value.ok ? r.value.info : null))
    .catch(() => null)
    .then((info) => {
      // a failed read is not kept, so the next ask tries again
      if (info === null && cache.get(layerId) === ask) cache.delete(layerId);
      return info;
    });
  cache.set(layerId, ask);
  return ask;
}

/** Show a dataset's main file in the file manager; null on success, else main's error text. */
export async function revealLayer(layerId: string): Promise<string | null> {
  const p = workspace.getState().project;
  if (!p) return t('layerProps.noProject');
  const r = await bridge.call('layer:reveal', { projectId: p.id, layerId });
  if (!r.ok) return r.error;
  return r.value.ok ? null : r.value.error;
}

setFileExtentSource((id) => readLayerInfo(id).then((i) => i?.extent ?? null));
