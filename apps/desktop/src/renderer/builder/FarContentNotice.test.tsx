// @vitest-environment jsdom
import type { PackageInfo, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { align, flags } = vi.hoisted(() => ({
  align: vi.fn(() => Promise.resolve()),
  flags: { readOnly: false },
}));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => flags.readOnly,
}));
vi.mock('./alignSession', () => ({
  // dropSession subscribes at import (one Ctrl+Z owner between the two notices)
  alignTo: { getState: () => ({ alignTo: align }), subscribe: () => () => undefined },
  alignCamera: { getState: () => ({ start: vi.fn() }) },
}));

const { FarContentNotice } = await import('./FarContentNotice');
const { farNotice } = await import('./farSession');
const { registerKindActions } = await import('../shell/actions/kindActions');
const { shell } = await import('../shell');
const { toasts } = await import('../exports/exports');

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
    flags.readOnly = false;
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

  it('a failed Align to says so in a toast', async () => {
    align.mockImplementationOnce(() => Promise.reject(new Error('Disk full')));
    farNotice.setState({ notice: notice(['ph']) });
    mount();
    act(() => byId('far-align-to')?.click());
    act(() => byId('align-to-mesh')?.click());
    await vi.waitFor(() => {
      expect(toasts.getState().toasts.at(-1)).toMatchObject({
        state: 'error',
        message: 'Disk full',
      });
    });
  });

  it('has no button without photo layers', () => {
    farNotice.setState({ notice: notice([]) });
    mount();
    expect(byId('far-align-to')).toBeNull();
  });

  it('greys the button in a package and says why', () => {
    farNotice.setState({ notice: notice(['ph']) });
    shell.setState({ pkg: { file: 'x.aio' } as unknown as PackageInfo });
    mount();
    const b = byId('far-align-to');
    expect(b).toBeInstanceOf(HTMLButtonElement);
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b?.title).toBe(t('actions.reason.package'));
  });

  it('greys the button for a reviewer who may only look', () => {
    farNotice.setState({ notice: notice(['ph']) });
    flags.readOnly = true;
    mount();
    const b = byId('far-align-to');
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b?.title).toBe(t('actions.reason.readOnly'));
  });
});
