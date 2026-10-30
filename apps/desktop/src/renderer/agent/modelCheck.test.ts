import { describe, expect, it, vi } from 'vitest';
import { createModelCheck, type ModelCheckSource } from './modelCheck';

function source(over: Partial<ModelCheckSource> = {}) {
  const saved = vi.fn<(projectId: string) => Promise<boolean | undefined>>(() =>
    Promise.resolve(false),
  );
  const s: ModelCheckSource = { now: () => false, saved, ...over };
  return { s, saved: (over.saved as typeof saved | undefined) ?? saved };
}

describe('agent model check', () => {
  it('is unknown without a source or a project, and true while a model is open', async () => {
    expect(await createModelCheck(() => null).has('p1')).toBeUndefined();
    const { s } = source({ now: () => true });
    const check = createModelCheck(() => s);
    expect(await check.has(undefined)).toBeUndefined();
    expect(await check.has('p1')).toBe(true);
  });

  it('keeps the answer per project until a model is written', async () => {
    const { s, saved } = source();
    const check = createModelCheck(() => s);
    expect(await check.has('p1')).toBe(false);
    expect(await check.has('p1')).toBe(false);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(await check.has('p2')).toBe(false);
    expect(saved).toHaveBeenCalledTimes(2);
    check.forget();
    await check.has('p2');
    expect(saved).toHaveBeenCalledTimes(3);
  });

  it('counts a slow or failed answer as unknown, and does not keep it', async () => {
    vi.useFakeTimers();
    try {
      const slow = vi.fn(() => new Promise<boolean | undefined>(() => undefined));
      const check = createModelCheck(() => ({ now: () => false, saved: slow }), 100);
      const pending = check.has('p1');
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    const failing = createModelCheck(() => ({
      now: () => false,
      saved: () => Promise.reject(new Error('no')),
    }));
    expect(await failing.has('p1')).toBeUndefined();
  });
});
