// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { align } = vi.hoisted(() => ({ align: vi.fn(() => Promise.resolve()) }));
vi.mock('./alignSession', () => ({
  alignTo: { getState: () => ({ alignTo: align }) },
  alignCamera: { getState: () => ({ start: vi.fn() }) },
}));

const { FarContentNotice } = await import('./FarContentNotice');
const { farNotice } = await import('./farSession');
const { registerKindActions } = await import('../shell/actions/kindActions');
const { shell } = await import('../shell');

const manifest = {
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Flight',
      visible: true,
      items: [{ id: 'a', pos: [91000, 40, 2000] }],
    },
    { kind: 'mesh', id: 'mesh', name: 'Site model', visible: true },
    { kind: 'pointcloud', id: 'cloud', name: 'Cloud', visible: true, format: 'copc' },
  ],
} as unknown as ProjectManifest;

const notice = (photoLayers: string[]) => ({
  projectId: 'p',
  text: 'Far.',
  canRecentre: false,
  target: null,
  busy: false,
  done: false,
  far: [],
  photoLayers,
});

let root: Root | undefined;
let host: HTMLElement;
let off: () => void;
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const mount = () => {
  root = createRoot(host);
  act(() => root?.render(<FarContentNotice />));
};

describe('FarContentNotice Align to', () => {
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    off = registerKindActions();
    align.mockClear();
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    off();
    farNotice.setState({ notice: null });
    shell.setState({ pkg: null });
  });

  it('opens the Align to list for the far photos and aligns to the pick', () => {
    farNotice.setState({ notice: notice(['ph']) });
    mount();
    act(() => byId('far-align-to')?.click());
    expect(byId('ctx-menu')).not.toBeNull();
    expect(byId('align-to-mesh')).not.toBeNull();
    expect(byId('align-to-ph')).toBeNull();
    act(() => byId('align-to-mesh')?.click());
    expect(align).toHaveBeenCalledWith({ layerIds: ['ph'] }, 'mesh');
  });

  it('has no button without photo layers', () => {
    farNotice.setState({ notice: notice([]) });
    mount();
    expect(byId('far-align-to')).toBeNull();
  });

  it('has no button in a package', () => {
    farNotice.setState({ notice: notice(['ph']) });
    shell.setState({ pkg: { path: 'x.aio' } as never });
    mount();
    expect(byId('far-align-to')).toBeNull();
  });
});
