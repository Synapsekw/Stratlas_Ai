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
  // the same ids and answers as `box_frame` in python/tests/test_detect_engine.py
  it.each([
    ['qwen3.5-9b-q4_k_m', 'qwen3'],
    ['qwen3-vl-4b-instruct-q4_k_m', 'qwen3'],
    ['Qwen3-VL-4B-Instruct', 'qwen3'],
    ['qwen3-8b-q4_k_m', 'qwen3'],
    ['qwen2.5-vl-7b-instruct-q4_k_m', 'qwen25'],
    ['qwen-vl', 'qwen25'],
    ['qwen30-x', 'qwen25'],
    ['my-qwen3-finetune', 'qwen25'],
    ['anything-else', 'qwen25'],
  ] as const)('%s answers boxes as the %s family', (id, family) => {
    expect(localVlmModel(id).family).toBe(family);
  });
  it('another Qwen3 model gets the Qwen3-VL floor', () => {
    expect(localVlmModel('qwen3-8b-q4_k_m')).toMatchObject({ family: 'qwen3', minFreeMb: 5600 });
    expect(localVlmModel('Qwen3.5-9B').serverArgs).toEqual(['--reasoning', 'off']);
  });
});
