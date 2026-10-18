// @vitest-environment jsdom
/**
 * The runner's stage wiring: the scene state it hands the layer, the camera framing a newly
 * selected unit, the floating card while the 3D view shows, and the card's drag reset per project.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveStage } from '@aio/engine';
import type * as EngineModule from '@aio/engine';
import { AntennasFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ShellModule from '../shell';
import type * as CardModule from './AntennaCard';
import type * as SceneModule from './antennaScene';
import { shell } from '../shell';
import {
  AntennaRunner,
  LABEL_GAP,
  LABEL_PAD_X,
  LABEL_PAD_Y,
  drawnLabelsRect,
  screenRectOf,
  selectedAreas,
  withDrawnLabels,
  withLabels,
} from './AntennaRunner';
import { resetCardDrag } from './AntennaCard';
import { AVOID_WEIGHT } from './cardPlacement';
import type { AntennaSceneState } from './antennaScene';
import { antennaStore, revealAntenna, selectAntenna, setAntennaSolo } from './antennaStore';

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
vi.mock('./AntennaCard', async (importOriginal) => ({
  ...(await importOriginal<typeof CardModule>()),
  resetCardDrag: vi.fn(),
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
/** The stage's canvas parent, where the card is drawn. */
const stageHost = () => getActiveStage()?.renderer.domElement.parentElement ?? null;
const card = () => stageHost()?.querySelector('[data-testid="antenna-card"]') ?? null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  flyTo.mockReset();
  vi.mocked(resetCardDrag).mockClear();
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

  it('shows the card for a selected unit while the 3D view is on screen', () => {
    expect(card()).toBeNull();
    act(() => {
      selectAntenna('ant-a3');
    });
    expect(card()).not.toBeNull();
    // the canvas parent was static: it is made a positioned box for the card
    expect(stageHost()?.style.position).toBe('relative');
    act(() => {
      shell.setState({ screen: 'projects' });
    });
    expect(card()).toBeNull();
    act(() => {
      shell.setState({ screen: 'scene', stageMode: 'map' });
    });
    expect(card()).toBeNull();
    act(() => {
      shell.setState({ stageMode: '3d' });
    });
    expect(card()).not.toBeNull();
    act(() => {
      selectAntenna(null);
    });
    expect(card()).toBeNull();
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

  it('resets the card drag when the project changes', () => {
    expect(resetCardDrag).not.toHaveBeenCalled();
    act(() => {
      workspace.setState({ project: project('p2') });
    });
    expect(resetCardDrag).toHaveBeenCalledTimes(1);
  });
});

describe('screenRectOf', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const el = (w: number, hgt: number) => {
    const d = document.createElement('div');
    d.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: w, height: hgt, right: w, bottom: hgt }) as DOMRect;
    return d;
  };
  const canvas = el(200, 200);
  const host = el(200, 200);

  it('bounds the projected points in host pixels', () => {
    const r = screenRectOf(
      [
        [-1, -1, 0],
        [1, 1, 0],
      ],
      camera,
      canvas,
      host,
    );
    expect([r?.x, r?.y, r?.w, r?.h].map((v) => Math.round(v ?? NaN))).toEqual([90, 90, 20, 20]);
  });

  it('is null behind the camera or wholly outside the host', () => {
    expect(screenRectOf([[0, 0, 20]], camera, canvas, host)).toBeNull();
    expect(screenRectOf([[30, 0, 0]], camera, canvas, host)).toBeNull();
  });
});

describe('withLabels', () => {
  const box = { x: 100, y: 100, w: 20, h: 40 };

  it('is the box when no label is on screen', () => {
    expect(withLabels(box, null)).toEqual(box);
  });

  it('grows the box over the label anchors and the room their text takes', () => {
    // a dimension label right of the box, the name label above it
    const anchors = { x: 110, y: 90, w: 30, h: 50 };
    expect(withLabels(box, anchors)).toEqual({
      x: 110 - LABEL_PAD_X,
      y: 90 - LABEL_PAD_Y,
      w: 140 + LABEL_PAD_X - (110 - LABEL_PAD_X),
      h: 140 + LABEL_PAD_Y - (90 - LABEL_PAD_Y),
    });
  });
});

describe('drawnLabelsRect and withDrawnLabels', () => {
  const box = { x: 100, y: 100, w: 20, h: 40 };
  const span = (cls: string, r: DOMRect, display = '') => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.display = display;
    el.getBoundingClientRect = () => r;
    return el;
  };

  it('bounds the selected labels as drawn, host-relative, and the card keeps a gap round them', () => {
    const host = document.createElement('div');
    host.getBoundingClientRect = () => new DOMRect(50, 20, 800, 600);
    const layer = document.createElement('div');
    layer.className = 'sv-labels antenna-labels';
    layer.append(
      // a 130 px wide angle label right of the box
      span('sv-label antenna-label--angle sel', new DOMRect(50 + 112, 20 + 120, 130, 18)),
      // the name above it
      span('sv-label antenna-label--name sel', new DOMRect(50 + 80, 20 + 70, 90, 18)),
      // a label out of view and a pin do not count
      span('sv-label antenna-label--dim sel', new DOMRect(0, 0, 500, 500), 'none'),
      span('sv-label antenna-label--pin', new DOMRect(0, 0, 500, 500)),
    );
    host.append(layer);
    const drawn = drawnLabelsRect(host);
    expect(drawn).toEqual({ x: 80, y: 70, w: 112 + 130 - 80, h: 120 + 18 - 70 });
    const grown = withDrawnLabels(box, drawn, null);
    expect(grown.x + grown.w).toBe(112 + 130 + LABEL_GAP);
    expect(grown).toEqual({
      x: 80 - LABEL_GAP,
      y: 70 - LABEL_GAP,
      w: 112 + 130 - 80 + 2 * LABEL_GAP,
      h: 140 - 70 + 2 * LABEL_GAP,
    });
  });

  it('weighs the box and each drawn label by its kind', () => {
    const host = document.createElement('div');
    host.getBoundingClientRect = () => new DOMRect(50, 20, 800, 600);
    const layer = document.createElement('div');
    layer.className = 'sv-labels antenna-labels';
    layer.append(
      span('sv-label antenna-label--name sel', new DOMRect(50 + 80, 20 + 70, 90, 18)),
      span('sv-label antenna-label--angle sel', new DOMRect(50 + 112, 20 + 120, 130, 18)),
      span('sv-label antenna-label--dim sel', new DOMRect(50 + 100, 20 + 145, 55, 18)),
      span('sv-label antenna-label--dim sel', new DOMRect(0, 0, 500, 500), 'none'),
      span('sv-label antenna-label--pin', new DOMRect(0, 0, 500, 500)),
    );
    host.append(layer);
    expect(selectedAreas(host, box)).toEqual([
      { rect: box, weight: AVOID_WEIGHT.box },
      { rect: { x: 80, y: 70, w: 90, h: 18 }, weight: AVOID_WEIGHT.name },
      { rect: { x: 112, y: 120, w: 130, h: 18 }, weight: AVOID_WEIGHT.angle },
      { rect: { x: 100, y: 145, w: 55, h: 18 }, weight: AVOID_WEIGHT.dim },
    ]);
  });

  it('falls back to the anchor pad before the labels are drawn', () => {
    const host = document.createElement('div');
    expect(drawnLabelsRect(host)).toBeNull();
    const anchors = { x: 110, y: 90, w: 30, h: 50 };
    expect(withDrawnLabels(box, null, anchors)).toEqual(withLabels(box, anchors));
  });
});
