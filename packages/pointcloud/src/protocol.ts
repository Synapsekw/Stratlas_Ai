import {
  loadCopcNode,
  readCopcPage,
  readCopcSource,
  type CopcHierarchy,
  type CopcNodeInfo,
  type CopcPage,
  type CopcSource,
  type Getter,
} from './copc';
import type { LasLayout, LazPerfLike } from './copcDecode';
import { decodeKitPacked, decodePngChunk, type Bounds3, type Quantisation } from './decode';
import { sampleHeights } from './heights';

type V3 = readonly [number, number, number];

export type DecodeRequest =
  | { id: number; kind: 'kit'; url: string; scale: number }
  | { id: number; kind: 'png'; url: string; points: number; quant: Quantisation }
  | {
      id: number;
      kind: 'copc';
      url: string;
      node: CopcNodeInfo;
      layout: LasLayout;
      /** Project origin [E, N, H] in the file CRS. */
      origin: V3;
      /** Node bounds in the local frame. */
      box: { min: V3; max: V3 };
    };

export type InfoRequest =
  | { id: number; kind: 'copc-source'; url: string }
  | { id: number; kind: 'copc-page'; url: string; page: CopcPage };

export type WorkerRequest = DecodeRequest | InfoRequest;

export interface DecodedChunk {
  id: number;
  count: number;
  /** Stored integer xyz; the object transform applies offset and scale. */
  position: Int16Array | Uint16Array;
  rgb?: Uint8Array;
  intensity?: Uint8Array;
  /** ASPRS class codes (COPC). */
  classification?: Uint8Array;
  /** Point count per class code (COPC). */
  classes?: Record<number, number>;
  /** Quantisation chosen by the decoder (COPC: uint16 over the node box). */
  quant?: { offset: [number, number, number]; scale: [number, number, number] };
  /** Tight bounds in the local frame, metres. */
  bounds: Bounds3;
  /** A spread sample of the points' local heights (Y), metres, for the elevation range. */
  heights?: Float32Array;
  /** One float per point to colour by in the change mode (COPC extra bytes). */
  scalar?: Float32Array;
}

export type DecodeResult = DecodedChunk | { id: number; error: string };

export type WorkerResult =
  DecodeResult | { id: number; source: CopcSource } | { id: number; hierarchy: CopcHierarchy };

export interface DecodeDeps {
  fetchBytes(url: string): Promise<ArrayBuffer>;
  decodeImage(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }>;
  /** COPC support: ranged reads and the laz-perf module. */
  copc?: {
    getter(url: string): Getter;
    lazPerf(): Promise<LazPerfLike>;
  };
}

/** Runs one decode request. Used by the worker; pure apart from the injected I/O. */
export async function handleDecode(
  req: DecodeRequest,
  deps: DecodeDeps,
): Promise<{ result: DecodeResult; transfer: ArrayBuffer[] }> {
  const r = await handleRequest(req, deps);
  return r as { result: DecodeResult; transfer: ArrayBuffer[] };
}

function needCopc(deps: DecodeDeps): NonNullable<DecodeDeps['copc']> {
  if (!deps.copc) throw new Error('COPC reading is not available in this decoder');
  return deps.copc;
}

/** Runs any worker request: chunk decodes and COPC metadata reads. */
export async function handleRequest(
  req: WorkerRequest,
  deps: DecodeDeps,
): Promise<{ result: WorkerResult; transfer: ArrayBuffer[] }> {
  try {
    switch (req.kind) {
      case 'kit': {
        const c = decodeKitPacked(await deps.fetchBytes(req.url), req.scale);
        const heights = sampleHeights(c.count, (i) => c.positions[3 * i + 1] ?? NaN);
        const result: DecodedChunk = {
          id: req.id,
          count: c.count,
          position: c.raw,
          intensity: c.intensity,
          bounds: c.bounds,
          heights,
        };
        return {
          result,
          transfer: [
            c.raw.buffer as ArrayBuffer,
            c.intensity.buffer as ArrayBuffer,
            heights.buffer as ArrayBuffer,
          ],
        };
      }
      case 'png': {
        const img = await deps.decodeImage(req.url);
        const c = decodePngChunk(img.data, img.w, img.h, req.quant, req.points);
        const heights = sampleHeights(c.count, (i) => c.positions[3 * i + 1] ?? NaN);
        const result: DecodedChunk = {
          id: req.id,
          count: c.count,
          position: c.raw,
          rgb: c.rgb,
          bounds: c.bounds,
          heights,
        };
        return {
          result,
          transfer: [
            c.raw.buffer as ArrayBuffer,
            c.rgb.buffer as ArrayBuffer,
            heights.buffer as ArrayBuffer,
          ],
        };
      }
      case 'copc-source': {
        const source = await readCopcSource(needCopc(deps).getter(req.url));
        return { result: { id: req.id, source }, transfer: [] };
      }
      case 'copc-page': {
        const hierarchy = await readCopcPage(needCopc(deps).getter(req.url), req.page);
        return { result: { id: req.id, hierarchy }, transfer: [] };
      }
      case 'copc': {
        const copc = needCopc(deps);
        const d = await loadCopcNode(
          copc.getter(req.url),
          req.node,
          req.layout,
          await copc.lazPerf(),
          req.origin,
          req.box,
        );
        const result: DecodedChunk = {
          id: req.id,
          count: d.count,
          position: d.position,
          quant: d.quant,
          classes: d.classes,
          bounds: d.bounds,
          heights: d.heights,
        };
        const transfer = [d.position.buffer as ArrayBuffer, d.heights.buffer as ArrayBuffer];
        for (const [key, arr] of [
          ['rgb', d.rgb],
          ['intensity', d.intensity],
          ['classification', d.classification],
        ] as const) {
          if (!arr) continue;
          result[key] = arr;
          transfer.push(arr.buffer as ArrayBuffer);
        }
        if (d.scalar) {
          result.scalar = d.scalar;
          transfer.push(d.scalar.buffer as ArrayBuffer);
        }
        return { result, transfer };
      }
    }
  } catch (e) {
    return {
      result: { id: req.id, error: e instanceof Error ? e.message : String(e) },
      transfer: [],
    };
  }
}
