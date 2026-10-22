import { CORRECTION_PROMPT_LEAD } from '@aio/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SEND_TIMEOUT_MESSAGE,
  afterDecision,
  allowCloudKinds,
  saveThenSend,
  sendCorrections,
  sendToAgent,
} from './correctionSend';

afterEach(() => {
  vi.useRealTimers();
});

describe('sendCorrections', () => {
  it('times out a hung prepare and rejects with the saved-request message', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());
    const result = sendCorrections({
      ids: ['fix-a'],
      prepare: () => new Promise<string>(() => undefined),
      send,
    });
    const settled = expect(result).rejects.toThrow(SEND_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    expect(SEND_TIMEOUT_MESSAGE).toBe(
      'The AI did not answer in time. Your request is saved; press Send to try again.',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('times out a hung send as well', async () => {
    vi.useFakeTimers();
    const result = sendCorrections({
      ids: ['fix-a'],
      prepare: () => Promise.resolve('{}'),
      send: () => new Promise<void>(() => undefined),
      timeoutMs: 5_000,
    });
    const settled = expect(result).rejects.toThrow(SEND_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
  });

  it('sends the correction prompt with the submitted data', async () => {
    const prepared = JSON.stringify({ requests: [{ id: 'fix-a' }] });
    const prepare = vi.fn<(ids: string[]) => Promise<string>>(() => Promise.resolve(prepared));
    const send = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    await sendCorrections({ ids: ['fix-a', 'fix-b'], prepare, send });
    expect(prepare).toHaveBeenCalledWith(['fix-a', 'fix-b']);
    const text = send.mock.calls[0]?.[0] ?? '';
    expect(text.startsWith(CORRECTION_PROMPT_LEAD)).toBe(true);
    expect(text.endsWith(prepared)).toBe(true);
  });

  it('keeps the saved request open when the send fails', async () => {
    // a fake correction session and agent session, wired the way the workbench wires them
    const requests: { id: string; status: string }[] = [];
    const session = {
      create: vi.fn(() => {
        const r = { id: `fix-${String(requests.length + 1)}`, status: 'open' };
        requests.push(r);
        return Promise.resolve(r);
      }),
      reject: vi.fn(() => Promise.resolve()),
      resend: vi.fn(() => Promise.resolve()),
    };
    const agentSend = vi.fn(() => Promise.reject(new Error('The AI route was switched off.')));
    const submit = () =>
      saveThenSend({
        save: async () => (await session.create()).id,
        send: (id) =>
          sendCorrections({ ids: [id], prepare: () => Promise.resolve('{}'), send: agentSend }),
      });

    await expect(submit()).resolves.toEqual({ sendError: 'The AI route was switched off.' });
    expect(session.create).toHaveBeenCalledTimes(1);
    expect(session.reject).not.toHaveBeenCalled();
    expect(session.resend).not.toHaveBeenCalled();
    expect(requests).toEqual([{ id: 'fix-1', status: 'open' }]);
    // the send itself rethrows; only the submit turns it into a saved-but-not-sent result
    await expect(
      sendCorrections({ ids: ['fix-1'], prepare: () => Promise.resolve('{}'), send: agentSend }),
    ).rejects.toThrow('The AI route was switched off.');
  });

  it('rejects, without sending, when the save fails', async () => {
    const send = vi.fn(() => Promise.resolve());
    await expect(
      saveThenSend({ save: () => Promise.reject(new Error('disk full')), send }),
    ).rejects.toThrow('disk full');
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves with nothing when saving only', async () => {
    await expect(saveThenSend({ save: () => Promise.resolve('fix-1') })).resolves.toBeUndefined();
  });
});

describe('sendToAgent', () => {
  const NOT_SENT = 'The AI did not start.';
  const agent = (
    before: { busy?: boolean; preview?: object | null; turns?: unknown[] },
    after: { busy?: boolean; preview?: object | null; turns?: unknown[] },
  ) => {
    let state = { busy: false, preview: null, turns: [], ...before };
    return {
      getState: () => state,
      send: vi.fn(() => {
        state = { ...state, ...after };
        return Promise.resolve();
      }),
    };
  };

  it('says sent when a run started', async () => {
    await expect(sendToAgent(agent({}, { busy: true }), 'fix', NOT_SENT)).resolves.toBe('sent');
    await expect(sendToAgent(agent({}, { turns: [1, 2] }), 'fix', NOT_SENT)).resolves.toBe('sent');
  });
  it('says preview when the send stopped at a new send preview', async () => {
    await expect(sendToAgent(agent({}, { preview: {} }), 'fix', NOT_SENT)).resolves.toBe('preview');
  });
  it('throws when the agent returned without sending', async () => {
    await expect(sendToAgent(agent({}, {}), 'fix', NOT_SENT)).rejects.toThrow(NOT_SENT);
    const open = {};
    await expect(sendToAgent(agent({ preview: open }, {}), 'fix', NOT_SENT)).rejects.toThrow(
      NOT_SENT,
    );
  });
});

describe('saveThenSend selection and outcome', () => {
  it('selects the saved request only once it was sent, so a failed send keeps Send in reach', async () => {
    const select = vi.fn();
    await saveThenSend({
      save: () => Promise.resolve('fix-1'),
      send: () => Promise.reject(new Error('no route')),
      select,
    });
    expect(select).not.toHaveBeenCalled();
    await saveThenSend({
      save: () => Promise.resolve('fix-2'),
      send: () => Promise.resolve(),
      select,
    });
    expect(select).toHaveBeenLastCalledWith('fix-2');
    await saveThenSend({ save: () => Promise.resolve('fix-3'), select });
    expect(select).toHaveBeenLastCalledWith('fix-3');
  });
  it('reports a send that waits on the send preview', async () => {
    await expect(
      saveThenSend({
        save: () => Promise.resolve('fix-1'),
        send: () => Promise.resolve('preview'),
      }),
    ).resolves.toEqual({ preview: true });
    await expect(
      sendCorrections({
        ids: ['fix-1'],
        prepare: () => Promise.resolve('{}'),
        send: () => Promise.resolve('preview'),
      }),
    ).resolves.toBe('preview');
  });
});

describe('afterDecision', () => {
  it('clears the selection after Accept so the box is ready for the next correction', () => {
    const ui = { setRequestId: vi.fn(), setView: vi.fn() };
    afterDecision('accept', ui);
    expect(ui.setRequestId).toHaveBeenCalledWith(undefined);
    expect(ui.setView).toHaveBeenCalledWith('before');
  });
  it('keeps the request selected after Reject so the person can reply and send again', () => {
    const ui = { setRequestId: vi.fn(), setView: vi.fn() };
    afterDecision('reject', ui);
    expect(ui.setRequestId).not.toHaveBeenCalled();
    expect(ui.setView).toHaveBeenCalledWith('before');
  });
});

describe('allowCloudKinds', () => {
  const project = { id: 'p1', root: 'C:/p1' };
  const manifest = { id: 'p1', aiCloudPhotos: true };
  const deps = (answers: Record<string, unknown>) => {
    const call = vi.fn((channel: string) => Promise.resolve(answers[channel]));
    const replaceManifest = vi.fn();
    return {
      call,
      replaceManifest,
      deps: {
        call: call as never,
        project: () => project,
        replaceManifest,
      },
    };
  };

  it('grants each missing kind and reloads the manifest', async () => {
    const d = deps({
      'ai:setCloudEvidence': { ok: true, value: { ok: true } },
      'ai:setCloudDrawings': { ok: true, value: { ok: true } },
      'project:open': { ok: true, value: { ok: true, manifest } },
    });
    await allowCloudKinds(['photos', 'scans', 'drawings'], d.deps);
    expect(d.call).toHaveBeenCalledWith('ai:setCloudEvidence', {
      projectId: 'p1',
      photos: true,
      scans: true,
    });
    expect(d.call).toHaveBeenCalledWith('ai:setCloudDrawings', { projectId: 'p1', allow: true });
    expect(d.replaceManifest).toHaveBeenCalledWith('p1', manifest);
  });

  it('throws the refusal when main refuses the grant', async () => {
    const d = deps({
      'ai:setCloudEvidence': {
        ok: true,
        value: { ok: false, error: 'This project is a read-only package.' },
      },
    });
    await expect(allowCloudKinds(['photos'], d.deps)).rejects.toThrow(
      'This project is a read-only package.',
    );
    expect(d.replaceManifest).not.toHaveBeenCalled();
  });

  it('throws when the bridge call itself fails', async () => {
    const d = deps({
      'ai:setCloudDrawings': { ok: false, error: 'The app bridge is not available.' },
    });
    await expect(allowCloudKinds(['drawings'], d.deps)).rejects.toThrow(
      'The app bridge is not available.',
    );
  });
});
