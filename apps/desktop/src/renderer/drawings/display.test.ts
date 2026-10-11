import { describe, expect, it } from 'vitest';
import { createStagePrefStore } from '../workspace/stagePrefs';
import { parseDrawingDisplay, withDrawingDisplay } from './display';

describe('drawing display preferences', () => {
  it('reads what was saved and drops what it cannot use', () => {
    expect(
      parseDrawingDisplay({
        a: { opacity: 0.4, onTop: true },
        b: { opacity: 7 },
        c: { opacity: 'x' },
        d: 3,
      }),
    ).toEqual({ a: { opacity: 0.4, onTop: true }, b: { opacity: 1 } });
    expect(parseDrawingDisplay({})).toBeUndefined();
    expect(parseDrawingDisplay('no')).toBeUndefined();
  });

  it('merges one change and keeps the other drawings', () => {
    const one = withDrawingDisplay(undefined, 'a', { opacity: 0.5 });
    const two = withDrawingDisplay(one, 'b', { onTop: true });
    expect(withDrawingDisplay(two, 'a', { onTop: true })).toEqual({
      a: { opacity: 0.5, onTop: true },
      b: { onTop: true },
    });
    expect(withDrawingDisplay({ b: { onTop: true } }, 'b', { onTop: false })).toBeUndefined();
  });

  it('is remembered per project with the other stage choices', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    } as unknown as Storage;
    const store = createStagePrefStore(storage);
    store.getState().update('p1', { telemetry: false });
    store.getState().update('p1', { drawings: { 'sheet-a': { opacity: 0.3 } } });
    const again = createStagePrefStore(storage);
    expect(again.getState().byProject.p1).toEqual({
      telemetry: false,
      drawings: { 'sheet-a': { opacity: 0.3 } },
    });
    expect(again.getState().byProject.p2).toBeUndefined();
  });
});
