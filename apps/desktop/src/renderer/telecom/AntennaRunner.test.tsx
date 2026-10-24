// @vitest-environment jsdom
/**
 * The runner's stage wiring: the scene state it hands the layer, the camera framing a newly
 * selected unit or a fly request, no floating card, the review keys and the delete dialog.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveStage } from '@aio/engine';
import type * as EngineModule from '@aio/engine';
import { AntennasFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ShellModule from '../shell';
import type * as SceneModule from './antennaScene';
import { shell } from '../shell';
import { AntennaRunner } from './AntennaRunner';
import { antennaDeleteStore } from './antennaDelete';
import type { AntennaSceneState } from './antennaScene';
import {
  antennaStore,
  requestFly,
  revealAntenna,
  selectAntenna,
  setAntennaSolo,
} from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(
  (): {
    getState: null | (() => AntennaSceneState);
    labels: number;
    onPick: null | ((id: string) => void);
    frames: Set<() => void>;
  } => ({ getState: null, labels: 0, onPick: null, frames: new Set() }),
);

vi.mock('../shell', async (importOriginal) => {
  const real = await importOriginal<typeof ShellModule>();
  return {
    ...real,
    bridge: {
      ...real.bridge,
      call: vi.fn(() => Promise.resolve({ ok: false, error: 'offline' })),
    },
  };
});
vi.mock('@aio/engine', async (importOriginal) => {
  const { PerspectiveCamera: Cam } = await import('three');
  const wrap = document.createElement('div');
  const canvas = document.createElement('canvas');
  wrap.append(canvas);
  const camera = new Cam(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const stage = {
    renderer: { domElement: canvas },
    camera,
    layerLoaded: () => true,
    onLayerLoaded: () => () => undefined,
    onFrame: (cb: () => void) => {
      h.frames.add(cb);
      return () => h.frames.delete(cb);
    },
  };
  return {
    ...(await importOriginal<typeof EngineModule>()),
    getActiveStage: () => stage,
    onActiveScene: () => () => undefined,
  };
});
vi.mock('./antennaScene', async (importOriginal) => ({
  ...(await importOriginal<typeof SceneModule>()),
  attachAntennaLayer: (
    _stage: unknown,
    _frame: unknown,
    opts: { getState(): AntennaSceneState },
  ) => {
    h.getState = () => opts.getState();
    return () => {
      h.getState = null;
    };
  },
}));
vi.mock('./antennaLabels', () => ({
  attachAntennaLabels: (_stage: unknown, _spots: unknown, onPick?: (id: string) => void) => {
    h.labels++;
    h.onPick = onPick ?? null;
    return () => {
      h.labels--;
    };
  },
}));
vi.mock('../builder/photoOpen', () => ({ openPhoto: () => undefined }));

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };

const project = (id: string) =>
  ({
    id,
    root: `C:/${id}`,
    manifest: {
      crs: { kind: 'local' },
      origin: [0, 0, 0],
      captures: [],
      layers: [{ kind: 'pointcloud', id: 'cloud-1', name: 'Cloud', visible: true }],
    },
  }) as unknown as NonNullable<ReturnType<typeof workspace.getState>['project']>;

let host: HTMLElement;
let root: Root;
const flyTo = vi.fn();
/** The stage's canvas parent, where the Labels control is drawn. */
const stageHost = () => getActiveStage()?.renderer.domElement.parentElement ?? null;
const card = () => stageHost()?.querySelector('[data-testid="antenna-card"]') ?? null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  flyTo.mockReset();
  antennaDeleteStore.setState({ ask: null, busy: false });
  shell.setState({ pkg: null, screen: 'scene', stageMode: '3d' });
  workspace.setState({ project: project('p1'), flyTo });
  antennaStore.setState({
    ...antennaStore.getInitialState(),
    projectId: 'p1',
    root: 'C:/p1',
    status: 'ready',
    file: AntennasFile.parse(structuredClone(contract.example)),
  });
  act(() => {
    root.render(<AntennaRunner />);
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
});

describe('AntennaRunner', () => {
  it('draws the layer with the store solo and attaches the labels', () => {
    expect(h.labels).toBe(1);
    expect(h.getState?.().solo).toBeNull();
    act(() => {
      setAntennaSolo('dish');
    });
    expect(h.getState?.().solo).toBe('dish');
  });

  it('flies to a newly selected unit, not to the same one again', () => {
    act(() => {
      selectAntenna('ant-a3');
    });
    expect(flyTo).toHaveBeenCalledTimes(1);
    expect(flyTo.mock.calls[0]?.[0]).toMatchObject({ kind: 'box' });
    act(() => {
      selectAntenna('ant-a3');
    });
    expect(flyTo).toHaveBeenCalledTimes(1);
    act(() => {
      selectAntenna('ant-d1');
    });
    expect(flyTo).toHaveBeenCalledTimes(2);
    // a pick in 3D flies too
    act(() => {
      revealAntenna('ant-o1');
    });
    expect(flyTo).toHaveBeenCalledTimes(3);
  });

  it('draws no floating card when a unit is selected', () => {
    act(() => {
      selectAntenna('ant-a3');
    });
    expect(card()).toBeNull();
    expect(document.querySelector('[data-testid="antenna-card"]')).toBeNull();
  });

  it('flies to every unit of a fly request, and not twice for the same request', () => {
    interface Box {
      min: number[];
      max: number[];
    }
    const last = () => flyTo.mock.calls.at(-1)?.[0] as Box;
    act(() => {
      requestFly(['ant-a3']);
    });
    const a = last();
    act(() => {
      requestFly(['ant-d1']);
    });
    const d = last();
    act(() => {
      requestFly(['ant-a3', 'ant-d1']);
    });
    const both = last();
    expect(flyTo).toHaveBeenCalledTimes(3);
    // the box covers both units: it holds each single box and is larger than either
    for (let i = 0; i < 3; i++) {
      expect(both.min[i]).toBeLessThanOrEqual(Math.min(a.min[i] ?? 0, d.min[i] ?? 0));
      expect(both.max[i]).toBeGreaterThanOrEqual(Math.max(a.max[i] ?? 0, d.max[i] ?? 0));
    }
    const size = (b: Box) => b.max.reduce((n, v, i) => n + v - (b.min[i] ?? 0), 0);
    expect(size(both)).toBeGreaterThan(size(a));
    expect(size(both)).toBeGreaterThan(size(d));
    act(() => {
      selectAntenna(null);
    });
    expect(flyTo).toHaveBeenCalledTimes(3);
  });

  it('Delete asks to delete the selected unit, and mounts the confirmation', () => {
    act(() => {
      selectAntenna('ant-a3');
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(antennaDeleteStore.getState().ask?.ids).toEqual(['ant-a3']);
    expect(document.querySelector('[data-testid="antenna-delete-confirm"]')).not.toBeNull();
  });

  it('shows the Labels control while the antennas are drawn, and Off sets the mode', () => {
    const control = () => stageHost()?.querySelector('[data-testid="antenna-labels-control"]');
    expect(control()).not.toBeNull();
    const group = control()?.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Labels');
    const all = control()?.querySelector<HTMLButtonElement>('[data-testid="antenna-labels-all"]');
    expect(all?.getAttribute('aria-pressed')).toBe('true');
    const off = control()?.querySelector<HTMLButtonElement>('[data-testid="antenna-labels-off"]');
    act(() => {
      off?.click();
    });
    expect(antennaStore.getState().labelMode).toBe('off');
    expect(off?.getAttribute('aria-pressed')).toBe('true');
    expect(all?.getAttribute('aria-pressed')).toBe('false');
    // the layer is told the mode, so it draws anew
    expect(h.getState?.().labelMode).toBe('off');
    act(() => {
      shell.setState({ stageMode: 'map' });
    });
    expect(control()).toBeNull();
  });

  it('a pin picks its unit as a box pick does, and the selected one again changes nothing', () => {
    const reveal = antennaStore.getState().reveal;
    act(() => {
      h.onPick?.('ant-a3');
    });
    expect(antennaStore.getState().selected).toBe('ant-a3');
    expect(antennaStore.getState().reveal).toBe(reveal + 1);
    expect(flyTo).toHaveBeenCalledTimes(1);
    act(() => {
      h.onPick?.('ant-a3');
    });
    expect(antennaStore.getState().reveal).toBe(reveal + 1);
    expect(flyTo).toHaveBeenCalledTimes(1);
  });
});
