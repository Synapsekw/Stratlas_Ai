import type { Layer, ProjectManifest } from '@aio/schema';
import type { ShimReply } from '../main/protocol/shim';
import type { Bridge } from './bridge';

export type LegacyLayer = Extract<Layer, { kind: 'legacy' }>;

/** The original offline viewers delivered with a project (`legacy` layers). */
export function legacyLayers(manifest: ProjectManifest | undefined): LegacyLayer[] {
  return (manifest?.layers ?? []).filter((l): l is LegacyLayer => l.kind === 'legacy');
}

/** Where a freshly opened project lands: its original review when that is all it has. */
export function landingScreen(manifest: ProjectManifest): 'review' | 'scene' {
  const layers = manifest.layers;
  return layers.length > 0 && layers.every((l) => l.kind === 'legacy' || l.kind === 'basemap')
    ? 'review'
    : 'scene';
}

export interface ShimSave {
  filename: string;
  data: string | Uint8Array<ArrayBuffer>;
}

/** A `downloads.save` posted by the legacy shim (see main/protocol/shim.ts), or null. */
export function readShimSave(msg: unknown): ShimSave | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.source !== 'stratlas-legacy' || m.type !== 'save') return null;
  if (typeof m.filename !== 'string') return null;
  if (typeof m.data !== 'string' && !(m.data instanceof Uint8Array)) return null;
  // Structured clone never hands over a SharedArrayBuffer here.
  return { filename: m.filename, data: m.data as string | Uint8Array<ArrayBuffer> };
}

/** Save through the native dialog and tell the viewer how it went. */
export async function answerShimSave(save: ShimSave, bridge: Bridge): Promise<ShimReply> {
  const r = await bridge.call('dialog:saveFile', { defaultName: save.filename, data: save.data });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value.path !== null) return { ok: true };
  if (r.value.error) return { ok: false, error: r.value.error };
  return { ok: false, code: 'declined' };
}
