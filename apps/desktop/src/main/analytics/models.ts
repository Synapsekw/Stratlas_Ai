/**
 * The local vision model table: what the Analytics pack's model id means for the server and the
 * card. One place maps the id to its box-frame family, the extra `llama-server` arguments, and
 * the free graphics memory it needs.
 */
import { VLM_MIN_FREE_VRAM_MB } from '@aio/schema';

export interface LocalVlmModel {
  /** Qwen3 family answers boxes in 0 to 1000; Qwen2.5-VL in sent pixels. */
  family: 'qwen25' | 'qwen3';
  /** Appended to the llama-server command line. */
  serverArgs: readonly string[];
  /** Free graphics memory (MB) the model needs to load. */
  minFreeMb: number;
  /** The server runs with thinking off. */
  thinkingOff: boolean;
}

/**
 * An id of the Qwen3 family (boxes in 0 to 1000): `qwen3` (or `qwen-3`, `qwen_3`), an optional
 * `.N` minor, then the end or anything but a digit or a dot. The detector job's `box_frame`
 * (python/src/aio_pipelines/detect/engine.py) uses the same rule, and both suites test the same
 * ids.
 */
export const QWEN3_FAMILY = /^qwen[-_ ]?3(?:\.\d+)?(?![\d.])/i;

export function localVlmModel(id: string): LocalVlmModel {
  const lower = id.toLowerCase();
  if (lower.startsWith('qwen3.5-')) {
    return {
      family: 'qwen3',
      serverArgs: ['--reasoning', 'off'],
      minFreeMb: 7400,
      thinkingOff: true,
    };
  }
  if (QWEN3_FAMILY.test(id)) {
    return { family: 'qwen3', serverArgs: [], minFreeMb: 5600, thinkingOff: false };
  }
  return { family: 'qwen25', serverArgs: [], minFreeMb: VLM_MIN_FREE_VRAM_MB, thinkingOff: false };
}
