// @vitest-environment jsdom
import { emptyOrientation } from '@aio/schema';
import { formatDate } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerProperties, layerProps } from './LayerProperties';
import { readLayerInfo } from './layerInfo';
import { renameRequest } from './renameRequest';

const shellPkg = vi.hoisted(() => ({ value: null as object | null }));
const setOffset = vi.hoisted(() => vi.fn());
vi.mock('../builder/dropSession', () => ({
  dropToGround: { getState: () => ({ setOffset }) },
}));
const call = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) },
  useShell: (f: (s: { pkg: object | null }) => unknown) => f({ pkg: shellPkg.value }),
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
  shellPkg.value = null;
  call.mockReset();
  setOffset.mockReset();
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
    const kind = [...(d?.querySelectorAll('dt') ?? [])].find((e) => e.textContent === 'Kind');
    expect(kind?.nextElementSibling?.textContent).toBe('Model');
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
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="layer-props-reveal"]')?.click();
      await Promise.resolve();
    });
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

  const openM = async () => {
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    await act(async () => {
      layerProps.getState().openLayer('m');
      await Promise.resolve();
    });
  };
  const text = () => document.querySelector('[data-testid="layer-props"]')?.textContent ?? '';

  it('shows the reading state before main answers', () => {
    call.mockReturnValue(new Promise(() => undefined));
    root = createRoot(host);
    act(() => root?.render(<LayerProperties />));
    act(() => {
      layerProps.getState().openLayer('m');
    });
    expect(text()).toContain('Reading the files...');
  });

  it('Escape closes the dialog', async () => {
    await openM();
    act(() => {
      document
        .querySelector('[data-testid="layer-props"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="layer-props"]')).toBeNull();
  });

  it('a failed layer:info shows an error line', async () => {
    call.mockResolvedValue({ ok: false, error: 'boom' });
    await openM();
    expect(document.querySelector('[data-testid="layer-props-error"]')?.textContent).toBe(
      'Could not read the files of this dataset.',
    );
  });

  it('a failed read is not cached', async () => {
    call.mockResolvedValueOnce({ ok: false, error: 'boom' });
    await openM();
    act(() => {
      layerProps.getState().close();
    });
    await openM();
    expect(call).toHaveBeenCalledTimes(2);
    expect(text()).toContain('models/m.glb');
  });

  it('reads the files again once the photo corrections change (an Align to moved a set)', async () => {
    await readLayerInfo('m');
    await readLayerInfo('m');
    expect(call).toHaveBeenCalledTimes(1);
    workspace.setState({ orientation: emptyOrientation() });
    await readLayerInfo('m');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shows the survey date the tree infers from the name', async () => {
    const p = workspace.getState().project;
    if (!p) throw new Error('no project');
    const [m] = p.manifest.layers;
    workspace.setState({
      project: {
        ...p,
        manifest: {
          ...p.manifest,
          captures: [...p.manifest.captures, { id: 'c2', label: 'c2', date: '2026-04-01' }],
          layers: [{ ...m, capture: undefined, name: 'Model 2026-03-02' }],
        },
      },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    await openM();
    const dt = [...document.querySelectorAll('dt')].find((e) => e.textContent === 'Survey date');
    expect(dt?.nextElementSibling?.textContent).toBe(formatDate('2026-03-02'));
  });

  it('hides Extent and Centre when the extent is null', async () => {
    call.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        info: {
          layerId: 'm',
          name: 'Model',
          kind: 'mesh',
          files: [],
          bytes: null,
          count: null,
          countKind: null,
          extent: null,
          crs: { epsg: 32639 },
          importedAt: null,
          mainFile: null,
        },
      },
    });
    await openM();
    expect(text()).not.toContain('Extent');
    expect(text()).not.toContain('Centre');
    expect(text()).toContain('Not known');
  });

  it('hides Rename and Reveal inside a package', async () => {
    shellPkg.value = {};
    await openM();
    expect(document.querySelector('[data-testid="layer-props-rename"]')).toBeNull();
    expect(document.querySelector('[data-testid="layer-props-reveal"]')).toBeNull();
  });

  it('shows a short message when Reveal fails', async () => {
    await openM();
    call.mockResolvedValue({ ok: true, value: { ok: false, error: 'ENOENT C:/x' } });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="layer-props-reveal"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not show the file in its folder.',
    );
  });

  it('closes when the dataset is no longer in the manifest', async () => {
    await openM();
    act(() => {
      const ws = workspace.getState().project;
      if (ws) {
        workspace.setState({
          project: { ...ws, manifest: { ...ws.manifest, layers: [] } },
        } as unknown as Partial<ReturnType<typeof workspace.getState>>);
      }
    });
    expect(document.querySelector('[data-testid="layer-props"]')).toBeNull();
    expect(layerProps.getState().open).toBeNull();
  });

  describe('height offset of a cloud', () => {
    const withCloud = (extra: Record<string, unknown> = {}) => {
      const p = workspace.getState().project;
      if (!p) throw new Error('no project');
      workspace.setState({
        project: {
          ...p,
          manifest: {
            ...p.manifest,
            layers: [
              ...p.manifest.layers,
              {
                kind: 'pointcloud',
                id: 'c',
                name: 'Cloud',
                visible: true,
                format: 'copc',
                capture: 'c1',
                ...extra,
              },
            ],
          },
        },
      } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    };
    const openC = async () => {
      root = createRoot(host);
      act(() => root?.render(<LayerProperties />));
      await act(async () => {
        layerProps.getState().openLayer('c');
        await Promise.resolve();
      });
    };
    const field = () =>
      document.querySelector<HTMLInputElement>('[data-testid="layer-props-height-offset"]');
    const save = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="layer-props-height-save"]');
    const type = (v: string) => {
      act(() => {
        const el = field();
        if (!el) throw new Error('no field');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    it('edits a cloud height offset', async () => {
      withCloud();
      await openC();
      expect(field()?.value).toBe('0');
      type('-30.81');
      expect(save()?.disabled).toBe(false);
      act(() => save()?.click());
      expect(setOffset).toHaveBeenCalledWith('c', -30.81);
    });

    it('saves on Enter, and zero clears the offset', async () => {
      withCloud({ heightOffsetM: 5 });
      await openC();
      expect(field()?.value).toBe('5');
      type('0');
      act(() => {
        field()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(setOffset).toHaveBeenCalledWith('c', null);
    });

    it('follows the manifest after an Undo', async () => {
      withCloud({ heightOffsetM: 5 });
      await openC();
      const p = workspace.getState().project;
      if (!p) throw new Error('no project');
      act(() => {
        workspace.setState({
          project: {
            ...p,
            manifest: {
              ...p.manifest,
              layers: p.manifest.layers.map((l) =>
                l.id === 'c' ? { ...l, heightOffsetM: 31 } : l,
              ),
            },
          },
        } as unknown as Partial<ReturnType<typeof workspace.getState>>);
      });
      expect(field()?.value).toBe('31');
    });

    it('disables Save for a non-number or beyond 2000 m', async () => {
      withCloud();
      await openC();
      for (const v of ['', 'abc', '2001', '-2001']) {
        type(v);
        expect(save()?.disabled, v).toBe(true);
      }
      type('2000');
      expect(save()?.disabled).toBe(false);
    });

    it('shows no height offset for a model or in a package', async () => {
      await openM();
      expect(field()).toBeNull();
      act(() => root?.unmount());
      shellPkg.value = {};
      withCloud();
      await openC();
      expect(field()).toBeNull();
      expect(save()).toBeNull();
    });
  });
});
