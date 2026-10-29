import { VLM_MIN_FREE_VRAM_MB } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { localVlmModel } from './models';

describe('localVlmModel', () => {
  it('Qwen3.5 runs with reasoning off and needs 7400 MB', () => {
    expect(localVlmModel('qwen3.5-9b-q4_k_m')).toEqual({
      family: 'qwen3',
      serverArgs: ['--reasoning', 'off'],
      minFreeMb: 7400,
      thinkingOff: true,
    });
  });
  it('Qwen3-VL needs 5600 MB and no extra arguments', () => {
    expect(localVlmModel('qwen3-vl-4b-q4_k_m')).toEqual({
      family: 'qwen3',
      serverArgs: [],
      minFreeMb: 5600,
      thinkingOff: false,
    });
  });
  it('anything else is the Qwen2.5-VL entry', () => {
    expect(localVlmModel('qwen2.5-vl-7b-instruct-q4_k_m')).toEqual({
      family: 'qwen25',
      serverArgs: [],
      minFreeMb: VLM_MIN_FREE_VRAM_MB,
      thinkingOff: false,
    });
    expect(localVlmModel('qwen-vl').family).toBe('qwen25');
  });
});
