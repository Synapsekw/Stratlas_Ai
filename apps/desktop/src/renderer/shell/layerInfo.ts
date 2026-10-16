import type { LayerInfo } from '@aio/schema';
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
  const ask = bridge
    .call('layer:info', { projectId: p.id, layerId })
    .then((r) => (r.ok && r.value.ok ? r.value.info : null))
    .catch(() => null);
  cache.set(layerId, ask);
  return ask;
}

/** Show a dataset's main file in the file manager; an error text or null. */
export async function revealLayer(layerId: string): Promise<string | null> {
  const p = workspace.getState().project;
  if (!p) return 'No project is open.';
  const r = await bridge.call('layer:reveal', { projectId: p.id, layerId });
  if (!r.ok) return r.error;
  return r.value.ok ? null : r.value.error;
}

setFileExtentSource((id) => readLayerInfo(id).then((i) => i?.extent ?? null));
