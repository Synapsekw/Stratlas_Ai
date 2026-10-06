/** onnxruntime-node for tests that run the synthetic detector for real (null when it cannot load). */
import { createRequire } from 'node:module';
import type { OrtNodeLike } from '../worker';

export function realOrt(): OrtNodeLike | null {
  try {
    return createRequire(import.meta.url)('onnxruntime-node') as OrtNodeLike;
  } catch {
    return null;
  }
}
