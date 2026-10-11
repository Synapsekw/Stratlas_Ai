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
  const DEFAULTS = { rightCollapsed: false, agentDockCollapsed: true };

  it('shows the right panel and folds the agent column when nothing is stored', () => {
    expect(DEFAULT_PANEL_PREFS).toEqual(DEFAULTS);
    expect(readPanelPrefs(memoryStorage())).toEqual(DEFAULTS);
    expect(readPanelPrefs(null)).toEqual(DEFAULTS);
  });

  it('reads back what it wrote, both panels', () => {
    const storage = memoryStorage();
    writePanelPrefs(storage, { rightCollapsed: true, agentDockCollapsed: false });
    expect(storage.data[PANEL_PREFS_KEY]).toBe(
      '{"rightCollapsed":true,"agentDockCollapsed":false}',
    );
    expect(readPanelPrefs(storage)).toEqual({ rightCollapsed: true, agentDockCollapsed: false });
    writePanelPrefs(storage, { rightCollapsed: false, agentDockCollapsed: true });
    expect(readPanelPrefs(storage)).toEqual({ rightCollapsed: false, agentDockCollapsed: true });
  });

  it('keeps a value stored before the agent column existed', () => {
    expect(parsePanelPrefs('{"rightCollapsed":true}')).toEqual({
      rightCollapsed: true,
      agentDockCollapsed: true,
    });
    expect(parsePanelPrefs('{"rightCollapsed":false}')).toEqual(DEFAULTS);
  });

  it('falls back to the default for anything that is not a stored choice', () => {
    for (const raw of [
      '',
      'not json',
      'null',
      '[]',
      '3',
      '{}',
      '{"rightCollapsed":"yes"}',
      '{"agentDockCollapsed":"no"}',
      '{"agentDockCollapsed":0}',
    ])
      expect(parsePanelPrefs(raw)).toEqual(DEFAULTS);
    expect(parsePanelPrefs(undefined)).toEqual(DEFAULTS);
    expect(parsePanelPrefs('{"agentDockCollapsed":false}')).toEqual({
      rightCollapsed: false,
      agentDockCollapsed: false,
    });
  });

  it('survives storage that refuses to read or write', () => {
    expect(readPanelPrefs(blocked)).toEqual(DEFAULTS);
    expect(() => {
      writePanelPrefs(blocked, { rightCollapsed: true, agentDockCollapsed: true });
    }).not.toThrow();
    expect(() => {
      writePanelPrefs(null, { rightCollapsed: true, agentDockCollapsed: true });
    }).not.toThrow();
  });
});
