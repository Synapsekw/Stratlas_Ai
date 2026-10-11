import { describe, expect, it } from 'vitest';
import { createImportRuns } from './importRuns';

describe('import runs', () => {
  it('cancels the running import of a project, and only that one', () => {
    const runs = createImportRuns();
    const a = runs.begin('a');
    const b = runs.begin('b');
    expect(runs.cancel('a')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('cancel');
    expect(b.signal.aborted).toBe(false);
  });

  it('answers false when nothing is running for the project', () => {
    const runs = createImportRuns();
    expect(runs.cancel('a')).toBe(false);
    const a = runs.begin('a');
    a.end();
    expect(runs.cancel('a')).toBe(false);
    expect(a.signal.aborted).toBe(false);
  });

  it('keeps two imports of one project apart: ending one leaves the other cancellable', () => {
    const runs = createImportRuns();
    const first = runs.begin('a');
    const second = runs.begin('a');
    first.end();
    expect(runs.cancel('a')).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
    // ending twice, or after a cancel, is harmless
    second.end();
    second.end();
    expect(runs.cancel('a')).toBe(false);
  });

  it('cancels everything when the app quits', () => {
    const runs = createImportRuns();
    const a = runs.begin('a');
    const b = runs.begin('b');
    const done = runs.begin('c');
    done.end();
    expect(runs.cancelAll()).toBe(2);
    // a quit is told apart from the person's Cancel: a finished copy is then kept, not removed
    expect(a.signal.reason).toBe('quit');
    expect([a.signal.aborted, b.signal.aborted, done.signal.aborted]).toEqual([true, true, false]);
    expect(runs.cancelAll()).toBe(0);
  });
});
