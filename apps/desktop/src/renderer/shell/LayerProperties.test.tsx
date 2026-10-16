// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerProperties, layerProps } from './LayerProperties';
import { renameRequest } from './renameRequest';

const call = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) },
  useShell: (f: (s: { pkg: null }) => unknown) => f({ pkg: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.setState({
    project: {
      id: 'p',
      root: 'C:/p',
      manifest: {
        name: 'Yard',
        crs: { epsg: 32639 },
        origin: [500000, 3200000, 0],
        captures: [{ id: 'c1', label: 'c1', date: '2026-03-02' }],
        layers: [
          {
            kind: 'mesh',
            id: 'm',
            name: 'Model',
            visible: true,
            capture: 'c1',
            src: { path: 'models/m.glb' },
            transform: [],
          },
        ],
      },
    },
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  call.mockReset();
  call.mockResolvedValue({
    ok: true,
    value: {
      ok: true,
      info: {
        layerId: 'm',
        name: 'Model',
        kind: 'mesh',
        files: [{ path: 'models/m.glb', bytes: 2048 }],
        bytes: 2048,
        count: null,
        countKind: null,
        extent: { min: [0, 0, -4], max: [6, 2, 0] },
        crs: { epsg: 32639 },
        importedAt: '2026-10-15T09:00:00.000Z',
        mainFile: 'models/m.glb',
      },
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  layerProps.getState().close();
  host.remove();
});

describe('LayerProperties', () => {
  it('shows name, kind, date, files, size, extent and CRS, read only', async () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    await act(async () => {
      layerProps.getState().openLayer('m');
      await Promise.resolve();
    });
    const d = document.querySelector('[data-testid="layer-props"]');
    expect(d?.getAttribute('role')).toBe('dialog');
    expect(d?.textContent).toContain('Properties of Model');
    expect(d?.textContent).toContain('Model'); // kind
    expect(d?.textContent).toContain('models/m.glb');
    expect(d?.textContent).toContain('2.0 KB');
    expect(d?.textContent).toContain('6 by 4 m, 2 m high');
    expect(d?.textContent).toContain('EPSG:32639');
    expect(d?.querySelector('input')).toBeNull();
    expect(call).toHaveBeenCalledWith('layer:info', { projectId: 'p', layerId: 'm' });
  });

  it('Rename closes the dialog and asks the sidebar for the name field; Reveal asks main', async () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    await act(async () => {
      layerProps.getState().openLayer('m');
      await Promise.resolve();
    });
    act(() => document.querySelector<HTMLElement>('[data-testid="layer-props-reveal"]')?.click());
    expect(call).toHaveBeenCalledWith('layer:reveal', { projectId: 'p', layerId: 'm' });
    act(() => document.querySelector<HTMLElement>('[data-testid="layer-props-rename"]')?.click());
    expect(renameRequest.getState().layerId).toBe('m');
    expect(document.querySelector('[data-testid="layer-props"]')).toBeNull();
  });

  it('project properties show the project fields without asking main', () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    act(() => {
      layerProps.getState().openProject();
    });
    expect(document.querySelector('[data-testid="layer-props"]')?.textContent).toContain(
      'Project properties',
    );
    expect(call).not.toHaveBeenCalled();
  });
});
