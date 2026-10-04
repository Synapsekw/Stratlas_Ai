import type { VolumeCompute } from '../model/compute';

/** The operations the worker offers: the public methods of VolumeCompute. */
export type VolumeOps = Pick<
  VolumeCompute,
  | 'recompute'
  | 'scene'
  | 'edit'
  | 'section'
  | 'pileSection'
  | 'changeRaster'
  | 'reliefRaster'
  | 'grid'
  | 'heights'
>;
export type VolumeOp = keyof VolumeOps;

export interface WorkerInit {
  /** URL patterns with `{id}` (pile) and `{epoch}`. */
  patterns: { pile: string; dsm: string; coarse: string };
  epochs: string[];
  deadband: number;
}

export type WorkerRequest =
  { kind: 'init'; init: WorkerInit } | { kind: 'call'; id: number; op: VolumeOp; args: unknown[] };

export type WorkerReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** The part of MessagePort / Worker / DedicatedWorkerGlobalScope both ends use. */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

/** ArrayBuffers inside a result, to transfer instead of copy. */
export function transferables(
  v: unknown,
  out = new Set<ArrayBuffer>(),
  depth = 0,
): Set<ArrayBuffer> {
  if (depth > 6 || v === null || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) {
    if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    return out;
  }
  for (const x of Array.isArray(v) ? v : Object.values(v)) transferables(x, out, depth + 1);
  return out;
}
