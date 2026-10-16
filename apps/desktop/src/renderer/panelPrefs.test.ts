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
  const DEFAULTS = { rightCollapsed: false, agentDockCollapsed: true, sidebarReopened: false };

  it('shows the right panel and folds the agent column when nothing is stored', () => {
    expect(DEFAULT_PANEL_PREFS).toEqual(DEFAULTS);
    expect(readPanelPrefs(memoryStorage())).toEqual(DEFAULTS);
    expect(readPanelPrefs(null)).toEqual(DEFAULTS);
  });

  it('reads back what it wrote, both panels', () => {
    const storage = memoryStorage();
    const both = { rightCollapsed: true, agentDockCollapsed: false, sidebarReopened: false };
    writePanelPrefs(storage, both);
    expect(storage.data[PANEL_PREFS_KEY]).toBe(
      '{"rightCollapsed":true,"agentDockCollapsed":false,"sidebarReopened":false}',
    );
    expect(readPanelPrefs(storage)).toEqual(both);
    writePanelPrefs(storage, DEFAULTS);
    expect(readPanelPrefs(storage)).toEqual(DEFAULTS);
  });

  it('remembers that the person reopened the sidebar the window folded', () => {
    const storage = memoryStorage();
    writePanelPrefs(storage, { ...DEFAULTS, sidebarReopened: true });
    expect(readPanelPrefs(storage)).toEqual({ ...DEFAULTS, sidebarReopened: true });
  });

  it('keeps a value stored before the agent column existed', () => {
    expect(parsePanelPrefs('{"rightCollapsed":true}')).toEqual({
      rightCollapsed: true,
      agentDockCollapsed: true,
      sidebarReopened: false,
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
      '{"sidebarReopened":"yes"}',
    ])
      expect(parsePanelPrefs(raw)).toEqual(DEFAULTS);
    expect(parsePanelPrefs(undefined)).toEqual(DEFAULTS);
    expect(parsePanelPrefs('{"agentDockCollapsed":false}')).toEqual({
      ...DEFAULTS,
      agentDockCollapsed: false,
    });
  });

  it('survives storage that refuses to read or write', () => {
    expect(readPanelPrefs(blocked)).toEqual(DEFAULTS);
    expect(() => {
      writePanelPrefs(blocked, { ...DEFAULTS, rightCollapsed: true });
    }).not.toThrow();
    expect(() => {
      writePanelPrefs(null, { ...DEFAULTS, rightCollapsed: true });
    }).not.toThrow();
  });
});
