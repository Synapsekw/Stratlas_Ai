// @vitest-environment jsdom
import type { Command, PaletteCommand } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ commands: [] as Command[] }));
vi.mock('@aio/ui', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  CommandPalette: ({ commands }: { commands: PaletteCommand[] }) => {
    h.commands = commands;
    return null;
  },
}));
import { shell } from '../shell';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import { rasterPacks } from '../workspace/siteTiles';
import { Palette } from './Palette';

let host: HTMLDivElement;
let root: Root | undefined;
const title = (id: string) => h.commands.find((c) => c.id === id)?.title;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  h.commands = [];
  workspace.setState({ project: { id: 'p', manifest: threeDates }, issues: [] } as never);
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

describe('palette map commands', () => {
  it('name every base map distinctly, Mapbox styles by their full name', () => {
    shell.setState({ paletteOpen: true } as never);
    act(() => {
      root = createRoot(host);
      root.render(<Palette />);
    });
    expect(title('map:base:streets')).toBe('Map: Streets');
    expect(title('map:base:mapbox-streets')).toBe('Map: Mapbox Streets');
    expect(title('map:base:mapbox-satellite')).toBe('Map: Mapbox Satellite');
    expect(title('map:base:mapbox-satellite-streets')).toBe('Map: Mapbox Satellite Streets');
    expect(title('basemap:online')).toBe('Turn online maps off');
  });
});
