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
    const a = [{ id: 'a' }] as never[];
    const b = [{ id: 'b' }] as never[];
    saver.schedule('p', a, { label: 'F01 severity 3 to 4', ids: ['i1'] });
    saver.schedule('p', b, { label: 'F01 to reviewed', ids: ['i1'] });
    await saver.flush();
    // one write per command, each with the list as it stood after it
    expect(write.mock.calls).toEqual([
      ['p', a, [{ label: 'F01 severity 3 to 4', ids: ['i1'] }]],
      ['p', b, [{ label: 'F01 to reviewed', ids: ['i1'] }]],
    ]);
    saver.schedule('p', []);
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith('p', []);
    saver.schedule('p', [], { label: 'Edit F01', ids: ['i1'] });
    saver.schedule('q', []);
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith('q', []);
  });

  it('merges a long burst of commands and still writes the newest list after a refusal', async () => {
    const write = vi.fn((_p: string, _i: unknown[], c?: unknown[]) =>
      Promise.resolve(c?.length === 1 ? { ok: false, error: 'refused' } : { ok: true }),
    );
    const saver = createIssueSaver({ write, delayMs: 100 });
    for (let i = 0; i < 25; i++) {
      saver.schedule('p', [{ id: String(i) }] as never[], { label: `C${String(i)}`, ids: ['i1'] });
    }
    await saver.flush();
    const calls = write.mock.calls;
    expect(calls[calls.length - 1]?.[1]).toEqual([{ id: '24' }]);
    const labels = calls.flatMap((c) => (c[2] ?? []) as { label: string }[]).map((x) => x.label);
    expect(labels).toContain('C24');
    expect(calls.length).toBeLessThanOrEqual(21);
    expect(saver.status.state).toBe('saved');
  });

  it('flushes immediately', async () => {
    const write = vi.fn(() => Promise.resolve({ ok: true }));
    const saver = createIssueSaver({ write, delayMs: 10_000 });
    saver.schedule('p', []);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
