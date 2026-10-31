// @vitest-environment jsdom
import type { Command, PaletteCommand } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ActiveSpace from '../spaces/activeSpace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  commands: [] as Command[],
  mapAvailable: true,
  splitHasMap: true,
}));
vi.mock('@aio/ui', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  CommandPalette: ({ commands }: { commands: PaletteCommand[] }) => {
    h.commands = commands;
    return null;
  },
}));
vi.mock('../spaces/activeSpace', async (orig) => {
  const real = await orig<typeof ActiveSpace>();
  return {
    ...real,
    useActiveSpace: () => ({ ...real.useActiveSpace(), mapAvailable: h.mapAvailable }),
  };
});
vi.mock('../spaces/splitMap', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSplitShowsMap: () => h.splitHasMap,
}));
import { shell } from '../shell';
import { rasterPacks } from '../workspace/siteTiles';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import { Palette } from './Palette';

let host: HTMLDivElement;
let root: Root | undefined;
const cmd = (id: string) => h.commands.find((c) => c.id === id) as PaletteCommand | undefined;

function mount() {
  shell.setState({ paletteOpen: true } as never);
  act(() => {
    root = createRoot(host);
    root.render(<Palette />);
  });
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  h.commands = [];
  h.mapAvailable = true;
  h.splitHasMap = true;
  workspace.setState({ project: { id: 'p', manifest: threeDates }, issues: [] } as never);
  shell.setState({ stageMode: '3d' } as never);
  rasterPacks.setState({
    imagery: [],
    terrain: [],
    online: { source: 'esri-world-imagery', keys: { esri: false, mapbox: true } },
  });
  rasterPacks.getState().setForSession({ onlineSatellite: true, mapBase: null });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null } as never);
});

describe('palette stage view commands without a map', () => {
  it('leaves a georeferenced project unchanged', () => {
    mount();
    for (const id of ['mode:3d', 'mode:map', 'mode:split']) {
      expect(cmd(id)?.disabled).toBeFalsy();
      expect(cmd(id)?.hint).toBeUndefined();
    }
    act(() => cmd('mode:map')?.run());
    expect(shell.getState().stageMode).toBe('map');
  });

  it('greys Map and Split with the reason in a space without a map, and running does nothing', () => {
    h.mapAvailable = false;
    mount();
    expect(cmd('mode:3d')?.disabled).toBeFalsy();
    expect(cmd('mode:map')?.disabled).toBe(true);
    expect(cmd('mode:map')?.hint).toBe('No map: this space has its own frame');
    expect(cmd('mode:split')?.disabled).toBe(true);
    act(() => cmd('mode:map')?.run());
    act(() => cmd('mode:split')?.run());
    expect(shell.getState().stageMode).toBe('3d');
  });

  it('keeps Split when the split it opens does not show the map', () => {
    h.mapAvailable = false;
    h.splitHasMap = false;
    mount();
    expect(cmd('mode:split')?.disabled).toBeFalsy();
    expect(cmd('mode:map')?.disabled).toBe(true);
    act(() => cmd('mode:split')?.run());
    expect(shell.getState().stageMode).toBe('split');
  });

  it('offers no base map command while the space has no map', () => {
    mount();
    expect(h.commands.some((c) => c.id.startsWith('map:base:'))).toBe(true);
    act(() => root?.unmount());
    h.mapAvailable = false;
    h.commands = [];
    act(() => {
      root = createRoot(host);
      root.render(<Palette />);
    });
    expect(h.commands.some((c) => c.id.startsWith('map:base:'))).toBe(false);
    expect(cmd('basemap:hillshade')).toBeUndefined();
  });
});
