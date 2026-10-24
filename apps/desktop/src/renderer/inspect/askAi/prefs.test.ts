// @vitest-environment jsdom
import { DEFAULT_BATCH } from '@aio/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askAiPrefs,
  cloudConfirmSkipped,
  lastCheck,
  readPrefs,
  rememberCheck,
  setAskAiPrefs,
  skipCloudConfirm,
} from './prefs';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ask AI preferences', () => {
  it('starts on Auto with the defaults', () => {
    expect(readPrefs()).toEqual({
      backend: 'auto',
      localModel: null,
      minConfidence: null,
      tile: { on: false, size: null, overlap: null },
      cloudBatch: DEFAULT_BATCH,
      queueThreshold: 0.5,
    });
  });

  it('migrates the old detect mode and model once', () => {
    window.localStorage.setItem('stratlas.detect.mode', 'detectors');
    window.localStorage.setItem('stratlas.detect.model', 'm1');
    expect(readPrefs()).toMatchObject({ backend: 'local', localModel: 'm1' });
    // once: the new key now holds the choice, a later old-key change is not read
    window.localStorage.setItem('stratlas.detect.mode', 'cloud');
    expect(readPrefs()).toMatchObject({ backend: 'local', localModel: 'm1' });
    window.localStorage.clear();
    window.localStorage.setItem('stratlas.detect.mode', 'cloud');
    expect(readPrefs()).toMatchObject({ backend: 'cloud', localModel: null });
  });

  it('keeps a stored choice and drops values of the wrong kind', () => {
    window.localStorage.setItem(
      'quadrion.askAi.prefs',
      JSON.stringify({ backend: 'sky', cloudBatch: 6, minConfidence: 'x', tile: { on: true } }),
    );
    expect(readPrefs()).toMatchObject({
      backend: 'auto',
      cloudBatch: 6,
      minConfidence: null,
      tile: { on: true, size: null, overlap: null },
    });
  });

  it('saves a change in the store and on this computer', () => {
    setAskAiPrefs({ backend: 'local', queueThreshold: 0.4 });
    expect(askAiPrefs.getState()).toMatchObject({ backend: 'local', queueThreshold: 0.4 });
    expect(readPrefs()).toMatchObject({ backend: 'local', queueThreshold: 0.4 });
  });

  it('works with no storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readPrefs()).toMatchObject({ backend: 'auto', localModel: null });
    expect(() => {
      setAskAiPrefs({ backend: 'cloud' });
    }).not.toThrow();
    expect(lastCheck('p')).toBeNull();
    expect(() => {
      rememberCheck('p', { kind: 'everything' });
      skipCloudConfirm('p');
    }).not.toThrow();
    expect(cloudConfirmSkipped('p')).toBe(false);
  });

  it('remembers the check and the cloud confirm per project', () => {
    expect(lastCheck('p')).toBeNull();
    rememberCheck('p', { kind: 'class', classId: 'corrosion' });
    expect(lastCheck('p')).toEqual({ kind: 'class', classId: 'corrosion' });
    expect(lastCheck('q')).toBeNull();
    window.localStorage.setItem('quadrion.askAi.check.q', JSON.stringify({ kind: 'nope' }));
    expect(lastCheck('q')).toBeNull();

    expect(cloudConfirmSkipped('p')).toBe(false);
    skipCloudConfirm('p');
    expect(cloudConfirmSkipped('p')).toBe(true);
    expect(cloudConfirmSkipped('q')).toBe(false);
  });
});
