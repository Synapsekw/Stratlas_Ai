import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_PREFS,
  PANEL_PREFS_KEY,
  parsePanelPrefs,
  readPanelPrefs,
  writePanelPrefs,
  type PanelStorage,
} from './panelPrefs';

function memoryStorage(initial: Record<string, string> = {}): PanelStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const blocked: PanelStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('panel preferences', () => {
  it('shows both panels when nothing is stored', () => {
    expect(DEFAULT_PANEL_PREFS).toEqual({ rightCollapsed: false });
    expect(readPanelPrefs(memoryStorage())).toEqual({ rightCollapsed: false });
    expect(readPanelPrefs(null)).toEqual({ rightCollapsed: false });
  });

  it('reads back what it wrote', () => {
    const storage = memoryStorage();
    writePanelPrefs(storage, { rightCollapsed: true });
    expect(storage.data[PANEL_PREFS_KEY]).toBe('{"rightCollapsed":true}');
    expect(readPanelPrefs(storage)).toEqual({ rightCollapsed: true });
    writePanelPrefs(storage, { rightCollapsed: false });
    expect(readPanelPrefs(storage)).toEqual({ rightCollapsed: false });
  });

  it('falls back to shown for anything that is not a stored choice', () => {
    for (const raw of ['', 'not json', 'null', '[]', '3', '{}', '{"rightCollapsed":"yes"}'])
      expect(parsePanelPrefs(raw)).toEqual({ rightCollapsed: false });
    expect(parsePanelPrefs(undefined)).toEqual({ rightCollapsed: false });
  });

  it('survives storage that refuses to read or write', () => {
    expect(readPanelPrefs(blocked)).toEqual({ rightCollapsed: false });
    expect(() => {
      writePanelPrefs(blocked, { rightCollapsed: true });
    }).not.toThrow();
    expect(() => {
      writePanelPrefs(null, { rightCollapsed: true });
    }).not.toThrow();
  });
});
