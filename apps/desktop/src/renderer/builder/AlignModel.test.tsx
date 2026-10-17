// @vitest-environment jsdom
import type { Georef, Layer, LayerPatch, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Intersection } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pick from './pick';

vi.mock('@aio/maps', () => ({ LocationPicker: () => null }));

/** The scene pick the panel arms, captured so a test can click. */
let scenePick: ((hit: Intersection | null) => void) | null = null;
vi.mock('./pick', async (importOriginal) => ({
  ...(await importOriginal<typeof Pick>()),
  useStagePick: (armed: boolean, cb: (hit: Intersection | null) => void) => {
    scenePick = armed ? cb : null;
  },
  usePickMarkers: () => undefined,
}));

const { AlignModel } = await import('./AlignModel');
const { builder } = await import('./state');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mesh: Layer = {
  kind: 'mesh',
  id: 'tower',
  name: 'Tower',
  visible: true,
  src: { path: 'models/tower.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

const manifest = (origin: [number, number, number]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin,
  captures: [],
  layers: [mesh],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const saveLayers = builder.getState().saveLayers;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  builder.setState({ saveLayers: () => Promise.resolve(null) });
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest: manifest([500000, 0, 0]) });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  builder.setState({ saveLayers });
  workspace.getState().closeProject();
});

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === name) ?? null;
const hit = (p: readonly number[], layerId?: string) =>
  ({
    point: { x: p[0], y: p[1], z: p[2] },
    object: { userData: layerId ? { layerId } : {}, parent: null },
  }) as unknown as Intersection;
const apply = (t: readonly number[], p: readonly number[]) =>
  [0, 1, 2].map(
    (r) =>
      (t[r] ?? 0) * (p[0] ?? 0) +
      (t[4 + r] ?? 0) * (p[1] ?? 0) +
      (t[8 + r] ?? 0) * (p[2] ?? 0) +
      (t[12 + r] ?? 0),
  );

describe('Georeference model', () => {
  it('forgets its Undo when the project origin moves (a re-centre)', async () => {
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    await act(async () => {
      button('Z up')?.click();
      await Promise.resolve();
    });
    expect(button('Undo')).not.toBeNull();

    // the same project reopened in a new frame: the old transform means something else now
    act(() => {
      workspace
        .getState()
        .openProject({ id: 'p', root: 'E:/p', manifest: manifest([530000, 0, 0]) });
    });
    expect(button('Undo')).toBeNull();
  });

  it('saves a fit on a lined-up date that reloads where it was put', async () => {
    // the model's date is lined up 2 m east and 1 m north: it is drawn at x 2, z -1
    workspace.getState().openProject({
      id: 'p',
      root: 'E:/p',
      manifest: {
        ...manifest([500000, 0, 0]),
        captures: [
          {
            id: 'd2',
            label: 'Second',
            date: '2026-02-10',
            lineUp: { eastM: 2, northM: 1, with: 'd1', at: '2026-10-16T08:00:00Z' },
          },
        ],
        layers: [{ ...mesh, capture: 'd2' }],
      },
    });
    const patches: LayerPatch[] = [];
    builder.setState({
      saveLayers: (_ids: readonly string[], patch: LayerPatch) => {
        patches.push(patch);
        return Promise.resolve(null);
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    // the true place: turned a quarter about the vertical and drawn 12 m east, 1 m north
    const target = (m: readonly number[]) => [(m[2] ?? 0) + 12, m[1] ?? 0, -(m[0] ?? 0) - 1];
    const model = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0, 10],
      [5, 3, 5],
    ];
    for (const m of model) {
      act(() => button('Pick on model')?.click());
      // clicked on the model where it is drawn
      act(() => {
        scenePick?.(hit([(m[0] ?? 0) + 2, m[1] ?? 0, (m[2] ?? 0) - 1], 'tower'));
      });
      act(() => button('Pick on the scene')?.click());
      act(() => {
        scenePick?.(hit(target(m)));
      });
    }
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="align-save"]')?.click();
      await Promise.resolve();
    });
    const saved = (patches[0] as { transform: number[] }).transform;
    // drawn again with the date's shift, every model point is on its target
    const drawn = [...saved];
    drawn[12] = (drawn[12] ?? 0) + 2;
    drawn[14] = (drawn[14] ?? 0) - 1;
    for (const m of model) {
      const got = apply(drawn, m);
      target(m).forEach((v, i) => {
        expect(got[i]).toBeCloseTo(v, 6);
      });
    }
  });

  it('offers a photo of a lined-up date as a target where the photo is drawn', () => {
    workspace.getState().openProject({
      id: 'p',
      root: 'E:/p',
      manifest: {
        ...manifest([500000, 0, 0]),
        captures: [
          {
            id: 'd2',
            label: 'Second',
            date: '2026-02-10',
            lineUp: { eastM: 2, northM: 1, with: 'd1', at: '2026-10-16T08:00:00Z' },
          },
        ],
        layers: [
          mesh,
          {
            kind: 'photos',
            id: 'shots',
            name: 'Shots',
            visible: true,
            capture: 'd2',
            items: [{ id: 'ph1', src: { path: 'ph1.jpg' }, pos: [10, 40, -20] }],
          },
        ],
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    act(() => button('Pick on model')?.click());
    act(() => {
      scenePick?.(hit([0, 0, 0], 'tower'));
    });
    act(() => button('Photo GPS')?.click());
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Photo"]');
    act(() => {
      if (!select) return;
      select.value = 'ph1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 10 m east and 20 m north of the origin, then the date's 2 m east and 1 m north
    const row = host.querySelector('table[aria-label="Point pairs"] tbody tr');
    expect(row?.textContent).toContain('500012.0 21.0 40.0');
  });

  it('saves a georeferenced model with its georeference and placement in one patch', async () => {
    const georef: Georef = {
      schema: 'aio.georef/1',
      crs: { epsg: 32639 },
      anchor: [500000, 0, 0],
      axes: 'x-east,y-up,z-south',
      units: 'm',
      modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 500000, 0, 0, 1],
      heading: { deg: 0, status: 'assumed-grid' },
      scale: { factor: 1, status: 'provisional' },
      horizontal: { status: 'unplaced' },
      vertical: { datum: 'unknown', status: 'unknown' },
      provenance: { by: 'engineer', runId: 'r1' },
    };
    const placed: Layer = { ...mesh, georef, placement: 'provisional' };
    workspace.getState().openProject({
      id: 'p',
      root: 'E:/p',
      manifest: { ...manifest([500000, 0, 0]), layers: [placed] },
    });
    const patches: LayerPatch[] = [];
    builder.setState({
      saveLayers: (_ids: readonly string[], patch: LayerPatch) => {
        patches.push(patch);
        return Promise.resolve(null);
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    await act(async () => {
      button('Z up')?.click();
      await Promise.resolve();
    });
    const saved = patches[0] as
      { transform?: number[]; georef?: Georef; placement?: string } | undefined;
    expect(saved?.placement).toBe('placed');
    expect(saved?.transform).toBeDefined();
    expect(saved?.georef?.provenance.by).toBe('place-model');
    // the record follows the new transform: Z up turns the model's up axis onto the grid's up
    expect(saved?.georef?.modelToCrs).not.toEqual(georef.modelToCrs);
    // Undo puts back all of it, in one write
    await act(async () => {
      button('Undo')?.click();
      await Promise.resolve();
    });
    expect(patches[1]).toEqual({
      transform: mesh.transform,
      georef,
      placement: 'provisional',
    });
  });
});
