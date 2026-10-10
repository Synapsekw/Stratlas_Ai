import { describe, expect, it } from 'vitest';
import type { Segmenter } from './inference/segment';
import { collectHandlers } from './notYet';
import { registerSurveyAiIpc } from './surveyAi';

describe('survey AI IPC (G12)', () => {
  const calls: unknown[] = [];
  const segmenter: Segmenter = {
    status: () => Promise.resolve({ available: false, reason: 'no-model' }),
    suggest: (req) => {
      calls.push(req);
      return Promise.resolve({
        ok: true,
        ring: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        score: 0.95,
        touchesEdge: false,
      });
    },
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyAiIpc({ handle, segmenter });
  });

  it('registers the status and suggest channels', () => {
    expect(ipc.channels()).toEqual(['surveyAi:status', 'surveyAi:suggest']);
  });

  it('answers the status through the contract', async () => {
    expect(await ipc.call('surveyAi:status', {})).toEqual({ available: false, reason: 'no-model' });
  });

  it('passes the click, crop, buffer and vertex count to the segmenter', async () => {
    const rgb = new Uint8Array(64 * 64 * 3);
    const crop = { key: 'ortho@k', size: 64, x0: 500_000, y1: 2_800_064, res: 1, rgb };
    const r = await ipc.call('surveyAi:suggest', {
      projectId: 'p',
      layer: 'ortho',
      click: [500_010.5, 2_800_020.25],
      crop,
      refine: [{ at: [500_020, 2_800_030], include: false }],
      bufferPx: 4,
      vertices: 40,
    });
    expect(r).toMatchObject({ ok: true, score: 0.95, touchesEdge: false });
    expect(calls[0]).toEqual({
      click: [500_010.5, 2_800_020.25],
      crop,
      refine: [{ at: [500_020, 2_800_030], include: false }],
      bufferPx: 4,
      vertices: 40,
    });
  });

  it('refuses a request without a crop (contract)', async () => {
    await expect(
      ipc.call('surveyAi:suggest', {
        projectId: 'p',
        layer: 'ortho',
        click: [0, 0],
      } as never),
    ).rejects.toThrow();
  });
});
