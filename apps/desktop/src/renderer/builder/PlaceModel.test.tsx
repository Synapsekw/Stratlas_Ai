// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import { composePlacement, decomposePlacement } from '@aio/engine';
import { fromWgs84, layerTransformToGeoref, projectToLocal } from '@aio/geo';
import type { Georef, Layer, LayerPatch, Mat4, PackageInfo, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Intersection } from 'three';

vi.mock('@aio/maps', () => ({ LocationPicker: () => null }));

/** The gizmo the panel drives, recorded. */
const gizmo = {
  attached: [] as Mat4[],
  shown: [] as Mat4[],
  modes: [] as string[],
  change: null as ((t: Mat4) => void) | null,
  drag: null as ((d: boolean) => void) | null,
  detached: 0,
  reset() {
    gizmo.attached = [];
    gizmo.shown = [];
    gizmo.modes = [];
    gizmo.change = null;
    gizmo.drag = null;
    gizmo.detached = 0;
  },
};
const fakeStage = { scene: { getObjectByName: () => undefined } };
let stageOn = true;
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveStage: () => (stageOn ? fakeStage : null),
  createPlaceGizmo: () => ({
    attach: (_id: string, t: Mat4) => gizmo.attached.push(t),
    set: (t: Mat4) => gizmo.shown.push(t),
    setMode: (m: string) => gizmo.modes.push(m),
    onChange: (cb: (t: Mat4) => void) => {
      gizmo.change = cb;
      return () => undefined;
    },
    onDrag: (cb: (d: boolean) => void) => {
      gizmo.drag = cb;
      return () => undefined;
    },
    detach: () => {
      gizmo.detached++;
    },
  }),
}));

/** The scene pick the panel arms, captured so a test can click. */
let scenePick: ((hit: Intersection | null) => void) | null = null;
vi.mock('./pick', () => ({
  terrainHeightAt: () => null,
  useStagePick: (armed: boolean, cb: (hit: Intersection | null) => void) => {
    scenePick = armed ? cb : null;
  },
}));

const { PlaceModel } = await import('./PlaceModel');
const { builder } = await import('./state');
const { shell } = await import('../shell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN: [number, number, number] = [500000, 4000000, 10];
const EPSG = 32639;
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GEOREF: Georef = {
  schema: 'aio.georef/1',
  crs: { epsg: EPSG },
  anchor: [500000, 4000000, 10],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 500000, 4000000, 10, 1],
  heading: { deg: 0, status: 'assumed-grid' },
  scale: { factor: 1, status: 'provisional' },
  horizontal: { status: 'unplaced' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer' },
};
const mesh = (extra: Partial<Extract<Layer, { kind: 'mesh' }>> = {}): Layer => ({
  kind: 'mesh',
  id: 'tower',
  name: 'Tower',
  visible: true,
  src: { path: 'models/tower.glb' },
  transform: I,
  ...extra,
});
const manifest = (layer: Layer): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: EPSG },
  origin: ORIGIN,
  captures: [],
  layers: [layer],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const saveLayers = builder.getState().saveLayers;
let saved: { ids: readonly string[]; patch: LayerPatch }[] = [];

function open(layer: Layer = mesh(), groundAt = vi.fn((): number | null => 3)) {
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest: manifest(layer) });
  act(() => {
    root = createRoot(host);
    root.render(<PlaceModel layerId="tower" groundAt={groundAt} />);
  });
  return groundAt;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  gizmo.reset();
  stageOn = true;
  saved = [];
  builder.setState({
    saveLayers: (ids, patch) => {
      saved.push({ ids, patch });
      return Promise.resolve(null);
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  builder.setState({ saveLayers });
  shell.setState({ pkg: null });
  workspace.getState().closeProject();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const field = (id: string) => q(id) as HTMLInputElement;
const type = (id: string, value: string, commit: 'blur' | 'enter' = 'blur') => {
  const el = field(id);
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    if (commit === 'enter') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // Enter in a form's field submits it (jsdom does not do that from a key event)
      el.form?.requestSubmit();
    } else el.blur();
  });
};
const last = () => gizmo.shown.at(-1) ?? gizmo.attached.at(-1) ?? I;
const placed = () => decomposePlacement(last(), 'y');
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('Place model', () => {
  it('puts the model where a point is clicked in the scene', () => {
    open();
    expect(gizmo.attached).toHaveLength(1);
    act(() => q('place-pick-scene')?.click());
    expect(scenePick).not.toBeNull();
    act(() => {
      scenePick?.({ point: { x: 12, y: 4, z: -7 } } as unknown as Intersection);
    });
    expect(placed().anchor).toEqual([12, 4, -7]);
    expect(scenePick).toBeNull();
  });

  it('takes E N H in the project CRS and latitude, longitude through WGS84', () => {
    open();
    type('place-typed', '500020 4000030 15', 'enter');
    expect(placed().anchor).toEqual(projectToLocal([500020, 4000030, 15], ORIGIN));
    type('place-typed', '36.1, 51.0, 12', 'enter');
    const p = fromWgs84([51.0, 36.1, 12], EPSG);
    const want = projectToLocal([p[0], p[1], 12], ORIGIN);
    const got = placed().anchor;
    expect(got.every((v, i) => near(v, want[i] ?? NaN))).toBe(true);
  });

  it('drops to the ground only when asked, once', () => {
    const groundAt = open();
    type('place-east', '5');
    expect(groundAt).not.toHaveBeenCalled();
    act(() => q('place-drop')?.click());
    expect(groundAt).toHaveBeenCalledTimes(1);
    expect(groundAt).toHaveBeenCalledWith(5, 0);
    expect(placed().anchor[1]).toBe(3);
  });

  it('moves with the fields and the handle; Undo steps back, Reset starts over', () => {
    open();
    type('place-east', '4');
    type('place-heading', '90', 'enter');
    expect(near(placed().anchor[0], 4)).toBe(true);
    expect(near(placed().headingDeg, 90)).toBe(true);
    // a drag on the handle
    const dragged = composePlacement({
      anchor: [4, 0, -10],
      headingDeg: 90,
      tiltXDeg: 0,
      tiltZDeg: 0,
      scale: 2,
      up: 'y',
    });
    act(() => {
      gizmo.drag?.(true);
      gizmo.change?.(dragged);
      gizmo.drag?.(false);
    });
    expect(field('place-north').value).toBe('10');
    expect(field('place-scale').value).toBe('2');
    act(() => q('place-undo')?.click());
    expect(near(placed().headingDeg, 90)).toBe(true);
    expect(near(placed().anchor[2], 0)).toBe(true);
    act(() => q('place-undo')?.click());
    expect(near(placed().headingDeg, 0)).toBe(true);
    act(() => q('place-reset')?.click());
    expect(placed().anchor).toEqual([0, 0, 0]);
    expect(saved).toEqual([]);
  });

  it('saves the transform alone for a plain model, and Undo after Done puts the old one back', async () => {
    open();
    type('place-east', '7');
    await act(async () => {
      q('place-done')?.click();
      await Promise.resolve();
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.ids).toEqual(['tower']);
    expect(saved[0]?.patch).toEqual({ transform: expect.any(Array) as unknown });
    expect(q('place-say')?.textContent).toContain('Placed and saved');
    await act(async () => {
      q('place-undo')?.click();
      await Promise.resolve();
    });
    expect(saved[1]?.patch).toEqual({ transform: I });
  });

  it('marks a georeferenced or waiting model placed with a georef the person set', async () => {
    open(mesh({ georef: GEOREF, placement: 'needed' }));
    type('place-north', '20');
    await act(async () => {
      q('place-done')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saved).toHaveLength(2);
    const t = (saved[0]?.patch as { transform: Mat4 }).transform;
    expect(saved[1]?.patch).toEqual({
      georef: layerTransformToGeoref(
        t,
        { crs: { epsg: EPSG }, origin: ORIGIN },
        GEOREF,
        'place-model',
      ),
      placement: 'placed',
    });
    const g = (saved[1]?.patch as { georef: Georef }).georef;
    expect([g.heading.status, g.scale.status, g.horizontal.status]).toEqual([
      'user',
      'user',
      'user',
    ]);
  });

  it('refuses a read-only package: the extract message and no handle', () => {
    shell.setState({
      pkg: { header: { readOnly: true, editPolicy: 'allow' } } as unknown as PackageInfo,
    });
    open();
    expect(q('place-readonly')?.textContent).toContain('read-only');
    expect(gizmo.attached).toHaveLength(0);
    expect(q('place-done')).toBeNull();
  });

  it('switches the handle between move, turn, tilt and scale, and lets go on close', () => {
    open();
    act(() => q('place-mode-rotate')?.click());
    act(() => q('place-mode-scale')?.click());
    expect(gizmo.modes).toEqual(['move', 'rotate', 'scale']);
    act(() => q('place-cancel')?.click());
    // the model goes back where the manifest has it
    expect(gizmo.shown.at(-1)).toEqual(I);
    expect(gizmo.detached).toBe(1);
    expect(builder.getState().align).toBeNull();
  });
});

describe('the import offers Place model', () => {
  it('for a model that still needs placing or was placed by a first guess', async () => {
    const { needsPlacing } = await import('./ImportPanel');
    const layers = [
      mesh({ id: 'a', placement: 'needed' }),
      mesh({ id: 'b', placement: 'provisional' }),
      mesh({ id: 'c', placement: 'placed' }),
      mesh({ id: 'd' }),
    ];
    expect(['a', 'b', 'c', 'd', 'x'].map((id) => needsPlacing(id, layers))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
