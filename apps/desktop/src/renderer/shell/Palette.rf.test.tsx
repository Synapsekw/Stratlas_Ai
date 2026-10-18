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
vi.mock('../rf/autoplan/autoplanStore', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startAutoplan: vi.fn(),
}));
import { antennasFile, unit } from '../rf/__fixtures__/rfData';
import { startAutoplan } from '../rf/autoplan/autoplanStore';
import { resetRf, rfStore } from '../rf/rfStore';
import { shell } from '../shell';
import { antennaStore } from '../telecom/antennaStore';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import { workbench } from '../workspace/workbench/workbenchStore';
import { Palette } from './Palette';

let host: HTMLDivElement;
let root: Root | undefined;
const command = (id: string) => h.commands.find((c) => c.id === id);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  h.commands = [];
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest: threeDates },
    issues: [],
  } as never);
  rfStore.setState({ projectId: 'p' });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.mocked(startAutoplan).mockClear();
  antennaStore.setState({ projectId: null, file: null, status: 'idle' });
  resetRf();
  workbench.getState().close('rf');
  workspace.setState({ project: null } as never);
});

const open = () => {
  shell.setState({ paletteOpen: true } as never);
  act(() => {
    root = createRoot(host);
    root.render(<Palette />);
  });
};

describe('palette: Coverage', () => {
  it('is not offered while the Coverage chip is hidden (no antennas)', () => {
    open();
    expect(command('rf:autoplan')).toBeUndefined();
    expect(command('rf:open')).toBeUndefined();
  });

  it('offers only Open Coverage panel before the antennas are reviewed', () => {
    antennaStore.setState({
      projectId: 'p',
      status: 'ready',
      file: antennasFile([unit('ant-a', 0, { status: 'draft' })]),
    });
    open();
    expect(command('rf:open')).toBeDefined();
    expect(command('rf:autoplan')).toBeUndefined();
  });

  it('offers Auto-plan coverage and Open Coverage panel once the project has antennas', () => {
    antennaStore.setState({
      projectId: 'p',
      status: 'ready',
      file: antennasFile([unit('ant-a', 0), unit('ant-b', 120)]),
    });
    open();
    expect(command('rf:autoplan')?.title).toBe('Auto-plan coverage');
    expect(command('rf:open')?.title).toBe('Open Coverage panel');
    act(() => {
      command('rf:open')?.run();
    });
    expect(workbench.getState().tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
    // the review dialog lives in the Coverage panel: the tab is open before Auto-plan starts
    act(() => {
      workbench.getState().close('rf');
    });
    let tabAtStart: boolean | undefined;
    vi.mocked(startAutoplan).mockImplementationOnce(() => {
      tabAtStart = workbench.getState().tabs.some((t) => t.id === 'rf');
      return Promise.resolve();
    });
    act(() => {
      command('rf:autoplan')?.run();
    });
    expect(startAutoplan).toHaveBeenCalled();
    expect(tabAtStart).toBe(true);
  });
});
