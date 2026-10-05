import { describe, expect, it } from 'vitest';
import { createStagePrefStore } from './stagePrefs';
import { telemetryLabels, telemetryOn } from './telemetryPref';

function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    raw: m,
  };
}

describe('drone telemetry preference', () => {
  it('is on by default and remembered per project', () => {
    const storage = memory();
    const store = createStagePrefStore(storage as unknown as Storage);
    expect(telemetryOn(store.getState(), 'alzour')).toBe(true);
    store.getState().update('alzour', { telemetry: false });
    expect(telemetryOn(store.getState(), 'alzour')).toBe(false);
    expect(telemetryOn(store.getState(), 'hcl')).toBe(true);
    // a new session reads it back
    const again = createStagePrefStore(storage as unknown as Storage);
    expect(telemetryOn(again.getState(), 'alzour')).toBe(false);
  });

  it('ignores a malformed stored value', () => {
    const storage = memory({ 'stratlas.stagePrefs': '{"alzour":{"telemetry":"no"}}' });
    const store = createStagePrefStore(storage as unknown as Storage);
    expect(telemetryOn(store.getState(), 'alzour')).toBe(true);
  });

  it('takes the HUD words from the catalogue', () => {
    expect(telemetryLabels()).toMatchObject({ distance: 'DIST', agl: 'AGL', start: 'START' });
  });
});
