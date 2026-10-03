import { afterEach, describe, expect, it } from 'vitest';
import { clearAdapters, getAdapter, registerAdapter, type LayerAdapter } from './index';

const mesh: LayerAdapter = {
  kind: 'mesh',
  create: () => Promise.resolve({ setVisible: () => undefined, dispose: () => undefined }),
};

describe('adapter registry', () => {
  afterEach(clearAdapters);

  it('registers and finds an adapter', () => {
    registerAdapter(mesh);
    expect(getAdapter('mesh')).toBe(mesh);
    expect(getAdapter('video')).toBeUndefined();
  });

  it('refuses a second adapter for the same kind', () => {
    registerAdapter(mesh);
    expect(() => {
      registerAdapter(mesh);
    }).toThrow('already registered');
  });
});
