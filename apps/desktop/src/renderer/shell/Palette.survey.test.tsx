// @vitest-environment jsdom
import type { PaletteCommand } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  commands: [] as { id: string; run: () => void }[],
  pickAndImportFolder: vi.fn(),
  toggleSidebar: vi.fn(),
  state: {
    pkg: null as { header: { exports: string[] } } | null,
    collapsed: false,
    readOnly: false,
  },
}));

vi.mock('@aio/ui', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  CommandPalette: ({ commands }: { commands: PaletteCommand[] }) => {
    h.commands = commands;
    return null;
  },
}));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => h.state.readOnly,
}));
import { builder } from '../builder/state';
import { shell } from '../shell';
import { addDateMenu } from './AddSurveyDate';
import { Palette } from './Palette';

let host: HTMLDivElement;
let root: Root | undefined;
function render() {
  shell.setState({
    paletteOpen: true,
    pkg: h.state.pkg,
    settings: { ...shell.getState().settings, sidebarCollapsed: h.state.collapsed },
    toggleSidebar: h.toggleSidebar,
  } as never);
  act(() => {
    root = createRoot(host);
    root.render(<Palette />);
  });
}
const find = (id: string) => h.commands.find((c) => c.id === id);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  h.state = { pkg: null, collapsed: false, readOnly: false };
  h.commands = [];
  h.pickAndImportFolder.mockClear();
  builder.setState({ pickAndImportFolder: h.pickAndImportFolder } as never);
  h.toggleSidebar.mockClear();
  addDateMenu.getState().set(false);
  workspace.setState({
    project: {
      id: 'p',
      manifest: { layers: [], captures: [], crs: { epsg: 32639 }, origin: [0, 0, 0] },
    },
    issues: [],
  } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null } as never);
});

describe('palette survey date commands', () => {
  it('lists both and runs them for an editable project', () => {
    render();
    act(() => find('add-survey-date')?.run());
    expect(addDateMenu.getState().open).toBe(true);
    expect(h.toggleSidebar).not.toHaveBeenCalled();
    act(() => find('import-flight-folder')?.run());
    expect(h.pickAndImportFolder).toHaveBeenCalledTimes(1);
  });

  it('opens a collapsed sidebar first', () => {
    h.state.collapsed = true;
    render();
    act(() => find('add-survey-date')?.run());
    expect(h.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(addDateMenu.getState().open).toBe(true);
  });

  it('hides both in a package, for a look-only reviewer, and with no project', () => {
    h.state.pkg = { header: { exports: [] } };
    render();
    expect(find('add-survey-date')).toBeUndefined();
    expect(find('import-flight-folder')).toBeUndefined();
    act(() => root?.unmount());
    h.state = { pkg: null, collapsed: false, readOnly: true };
    render();
    expect(find('add-survey-date')).toBeUndefined();
    act(() => root?.unmount());
    h.state.readOnly = false;
    workspace.setState({ project: null } as never);
    render();
    expect(find('add-survey-date')).toBeUndefined();
  });
});
