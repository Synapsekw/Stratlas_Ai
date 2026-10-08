import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerSurveyAiIpc } from './surveyAi';

describe('survey AI IPC (G0 stub)', () => {
  const ipc = collectHandlers((handle) => {
    registerSurveyAiIpc({ handle });
  });

  it('registers the suggest channel', () => {
    expect(ipc.channels()).toEqual(['surveyAi:suggest']);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(
      await ipc.call('surveyAi:suggest', {
        projectId: 'p',
        layer: 'ortho',
        click: [500_100.5, 2_800_200.25],
        bufferPx: 4,
        vertices: 40,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
