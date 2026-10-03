import { decodeKitPacked, decodePngChunk, type Bounds3, type Quantisation } from './decode';

export type DecodeRequest =
  | { id: number; kind: 'kit'; url: string; scale: number }
  | { id: number; kind: 'png'; url: string; points: number; quant: Quantisation };

export interface DecodedChunk {
  id: number;
  count: number;
  /** Stored integer xyz; the object transform applies offset and scale. */
  position: Int16Array | Uint16Array;
  rgb?: Uint8Array;
  intensity?: Uint8Array;
  /** Tight bounds in the local frame, metres. */
  bounds: Bounds3;
}

export type DecodeResult = DecodedChunk | { id: number; error: string };

export interface DecodeDeps {
  fetchBytes(url: string): Promise<ArrayBuffer>;
  decodeImage(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }>;
}

/** Runs one request. Used by the worker; pure apart from the injected I/O. */
export async function handleDecode(
  req: DecodeRequest,
  deps: DecodeDeps,
): Promise<{ result: DecodeResult; transfer: ArrayBuffer[] }> {
  try {
    if (req.kind === 'kit') {
      const c = decodeKitPacked(await deps.fetchBytes(req.url), req.scale);
      const result: DecodedChunk = {
        id: req.id,
        count: c.count,
        position: c.raw,
        intensity: c.intensity,
        bounds: c.bounds,
      };
      return { result, transfer: [c.raw.buffer as ArrayBuffer, c.intensity.buffer as ArrayBuffer] };
    }
    const img = await deps.decodeImage(req.url);
    const c = decodePngChunk(img.data, img.w, img.h, req.quant, req.points);
    const result: DecodedChunk = {
      id: req.id,
      count: c.count,
      position: c.raw,
      rgb: c.rgb,
      bounds: c.bounds,
    };
    return { result, transfer: [c.raw.buffer as ArrayBuffer, c.rgb.buffer as ArrayBuffer] };
  } catch (e) {
    return {
      result: { id: req.id, error: e instanceof Error ? e.message : String(e) },
      transfer: [],
    };
  }
}
