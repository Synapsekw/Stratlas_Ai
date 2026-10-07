import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeIssue } from '../testing';
import { createIssueSaver, type SaveStateName } from './persist';

describe('createIssueSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces writes and reports state', async () => {
    const write = vi.fn(() => Promise.resolve({ ok: true }));
    const states: SaveStateName[] = [];
    const saver = createIssueSaver({ write, delayMs: 500 });
    saver.subscribe((s) => states.push(s.state));
    saver.schedule('p', [makeIssue()]);
    saver.schedule('p', [makeIssue(), makeIssue({ id: 'b', code: 'F02' })]);
    expect(saver.status.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(499);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual(['p', [makeIssue(), makeIssue({ id: 'b', code: 'F02' })]]);
    expect(saver.status.state).toBe('saved');
    expect(states).toEqual(['pending', 'saving', 'saved']);
  });

  it('reports a failed write with its message', async () => {
    const saver = createIssueSaver({
      write: () => Promise.resolve({ ok: false, error: 'Disk full' }),
      delayMs: 10,
    });
    saver.schedule('p', []);
    await vi.advanceTimersByTimeAsync(10);
    expect(saver.status).toMatchObject({ state: 'error', error: 'Disk full' });
  });

  it('reports a thrown error', async () => {
    const saver = createIssueSaver({
      write: () => Promise.reject(new Error('IPC down')),
      delayMs: 1,
    });
    saver.schedule('p', []);
    await vi.advanceTimersByTimeAsync(1);
    expect(saver.status).toMatchObject({ state: 'error', error: 'IPC down' });
  });

  it('writes again when changes arrive during a save', async () => {
    let resolve: (v: { ok: boolean }) => void = () => undefined;
    const write = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((r) => {
          resolve = r;
        }),
    );
    const saver = createIssueSaver({ write, delayMs: 5 });
    saver.schedule('p', []);
    await vi.advanceTimersByTimeAsync(5);
    saver.schedule('p', [makeIssue()]);
    resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.status.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(5);
    resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(saver.status.state).toBe('saved');
  });

  it('carries the editor commands queued since the last write, then starts again', async () => {
    const write = vi.fn(() => Promise.resolve({ ok: true }));
    const saver = createIssueSaver({ write, delayMs: 100 });
    saver.schedule('p', [], { label: 'F01 severity 3 to 4', ids: ['i1'] });
    saver.schedule('p', [], { label: 'F01 to reviewed', ids: ['i1'] });
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith(
      'p',
      [],
      [
        { label: 'F01 severity 3 to 4', ids: ['i1'] },
        { label: 'F01 to reviewed', ids: ['i1'] },
      ],
    );
    saver.schedule('p', []);
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith('p', []);
    saver.schedule('p', [], { label: 'Edit F01', ids: ['i1'] });
    saver.schedule('q', []);
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith('q', []);
  });

  it('flushes immediately', async () => {
    const write = vi.fn(() => Promise.resolve({ ok: true }));
    const saver = createIssueSaver({ write, delayMs: 10_000 });
    saver.schedule('p', []);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
