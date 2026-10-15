// @vitest-environment jsdom
import type { PackageInfo } from '@aio/schema';
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
import { engineerUi } from '../engineer/ui';
import { shell } from '../shell';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import { Palette } from './Palette';

let host: HTMLDivElement;
let root: Root | undefined;
const command = (id: string) => h.commands.find((c) => c.id === id);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  h.commands = [];
  engineerUi.setState({ open: false, preselect: [] });
  workspace.setState({
    project: { id: 'p', manifest: threeDates },
    issues: [],
    selection: { kind: 'layer', id: 'model-oct' },
  } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState({ pkg: null } as never);
  workspace.setState({ project: null, selection: null } as never);
});

const open = () => {
  shell.setState({ paletteOpen: true } as never);
  act(() => {
    root = createRoot(host);
    root.render(<Palette />);
  });
};

describe('palette: Create engineering model', () => {
  it('opens the setup with the selected layer chosen, and starts nothing', () => {
    open();
    const c = command('engineer:create');
    expect(c?.title).toBe('Create engineering model from point clouds, models or photos');
    act(() => {
      c?.run();
    });
    expect(engineerUi.getState()).toMatchObject({ open: true, preselect: ['model-oct'] });
  });

  it('is not offered in a read-only package', () => {
    shell.setState({
      pkg: { header: { readOnly: true, exports: [] } } as unknown as PackageInfo,
    } as never);
    open();
    expect(command('engineer:create')).toBeUndefined();
  });
});
