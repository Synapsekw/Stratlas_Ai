// @vitest-environment jsdom
import { servePreview, type PreviewPort, type PreviewReply } from '@aio/rf';
import type { AntennasFile, ProjectManifest, RfSectorsFile } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Group } from 'three';
import { Mesh, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ShellModule from '../shell';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import {
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  antennasFile,
  lteSettings,
  sectorsFile,
  unit,
} from './__fixtures__/rfData';
import { CoverageGroup } from './CoverageGroup';
import { loadRfLayer, rfLayer, setRfLayerStorage } from './coverageDisplay';
import { BORESIGHT_LAYER, COVERAGE_LAYER, COVERAGE_SOURCE } from './coverageMap';
import { SCENE_GROUP } from './coverageScene';
import { coverage } from './coverageStore';
import type * as PreviewClientModule from './previewClient';
import type { PreviewClientPort } from './previewClient';
import { RfLayer } from './RfLayer';
import { patchSettings, patchStudy, resetRf, rfStore } from './rfStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  antennas: null as AntennasFile | null,
  sectors: null as RfSectorsFile | null,
  runs: [] as unknown[],
  workers: { started: 0, terminated: 0 },
  rays: [] as [number, number][],
  map: null as object | null,
  scene: null as object | null,
}));

vi.mock('../shell', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellModule>()),
  bridge: {
    call: vi.fn((channel: string, req?: unknown) => {
      switch (channel) {
        case 'telecom:readAntennas':
          return Promise.resolve({
            ok: true,
            value: { ok: true, file: structuredClone(h.antennas), readOnly: false },
          });
        case 'rf:readSectors':
          return Promise.resolve({
            ok: true,
            value: { ok: true, file: structuredClone(h.sectors), readOnly: false, orphans: [] },
          });
        case 'rf:listCatalogue':
          return Promise.resolve({
            ok: true,
            value: {
              ok: true,
              entries: [ANTENNA_ENTRY, RADIO_ENTRY].map((entry) => ({ origin: 'builtin', entry })),
              warnings: [],
            },
          });
        case 'rf:listRuns':
          return Promise.resolve({ ok: true, value: { ok: true, runs: structuredClone(h.runs) } });
        case 'rf:readRun': {
          const runs = h.runs as { runId: string }[];
          const run = runs.find((r) => r.runId === (req as { runId: string }).runId);
          return Promise.resolve({
            ok: true,
            value: run ? { ok: true, run } : { ok: false, error: 'no' },
          });
        }
        default:
          return Promise.resolve({ ok: true, value: { ok: true } });
      }
    }),
  },
}));

// the map and the 3D view on screen
vi.mock('../builder/activeViews', () => ({
  useMap: () => h.map,
  useScene: () => h.scene,
}));
// the shell's ray straight down onto a layer: a flat DSM 5 m above the project origin
vi.mock('../shell/appBounds', () => ({
  appBoundsDeps: () => ({
    rayDown: (x: number, z: number) => {
      h.rays.push([x, z]);
      return 5;
    },
  }),
}));
// jsdom has no canvas: any URL stands for the picture
vi.mock('./coverageCanvas', () => ({
  imageUrl: (img: { width: number; height: number }) =>
    `data:image/png;${String(img.width)}x${String(img.height)}`,
}));
// the preview Worker, as an in-memory channel to `servePreview` (what preview.worker.ts runs)
vi.mock('./previewClient', async (importOriginal) => {
  const real = await importOriginal<typeof PreviewClientModule>();
  return {
    ...real,
    startPreviewWorker: () => {
      h.workers.started++;
      const client: PreviewClientPort = {
        onmessage: null,
        terminate() {
          h.workers.terminated++;
        },
        postMessage(m) {
          queueMicrotask(() => worker.onmessage?.({ data: m }));
        },
      };
      const worker: PreviewPort = {
        onmessage: null,
        postMessage(m: PreviewReply) {
          queueMicrotask(() => client.onmessage?.({ data: m }));
        },
      };
      servePreview(worker);
      return real.connectPreview(client);
    },
  };
});

/** A MapLibre stand-in: its sources, its layers and their visibility. */
function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const layers = new Map<
    string,
    { layout: Record<string, unknown>; paint: Record<string, unknown> }
  >();
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: Record<string, unknown>) => {
      sources.set(id, {
        ...s,
        updateImage: (o: Record<string, unknown>) => sources.set(id, { ...sources.get(id), ...o }),
        setData: (d: unknown) => sources.set(id, { ...sources.get(id), data: d }),
      });
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (
      l: { id: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> },
      before?: string,
    ) => {
      layers.set(l.id, { layout: { ...l.layout }, paint: { ...l.paint } });
      const at = before === undefined ? -1 : order.indexOf(before);
      if (at < 0) order.push(l.id);
      else order.splice(at, 0, l.id);
    },
    removeLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
      return layers.delete(id);
    },
    setPaintProperty: (id: string, k: string, v: unknown) => {
      const l = layers.get(id);
      if (l) l.paint[k] = v;
    },
    setLayoutProperty: (id: string, k: string, v: unknown) => {
      const l = layers.get(id);
      if (l) l.layout[k] = v;
    },
    on: () => undefined,
    off: () => undefined,
    once: () => undefined,
  };
  return { ctl: { map }, sources, layers, order };
}

function fakeScene() {
  const scene = new Scene();
  return { scene, requestRender: vi.fn() };
}

const MANIFEST_SHIFT = { eastM: 12, northM: -7 };

let root: Root;
let host: HTMLDivElement;
let map: ReturnType<typeof fakeMap>;
let scene: ReturnType<typeof fakeScene>;

const wait = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

/** Wait until `fn` holds (the debounced preview, the Worker round trip). */
async function until(fn: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error(`timed out: ${label}`);
}

beforeEach(async () => {
  resetRf();
  h.runs = [];
  h.workers = { started: 0, terminated: 0 };
  setRfLayerStorage(null);
  loadRfLayer(null);
  const file = antennasFile([unit('ant-a', 0), unit('ant-b', 120), unit('ant-c', 240)]);
  h.antennas = { ...file, run: { ...file.run, captureId: 'cap-1' } };
  const sectors = sectorsFile(
    [
      { id: 'sec-a', antennaIds: ['ant-a'] },
      { id: 'sec-b', antennaIds: ['ant-b'] },
      { id: 'sec-c', antennaIds: ['ant-c'] },
    ],
    [lteSettings('ant-a'), lteSettings('ant-b'), lteSettings('ant-c')],
  );
  sectors.study = { ...sectors.study, radiusM: 200, gridResolutionM: 20 };
  h.sectors = sectors;
  map = fakeMap();
  scene = fakeScene();
  h.map = map.ctl;
  h.scene = scene;
  const manifest = {
    ...threeDates,
    crs: { epsg: 32640 },
    origin: [500_000, 2_700_000, 100],
    captures: [
      {
        id: 'cap-1',
        label: 'Survey',
        lineUp: { ...MANIFEST_SHIFT, with: 'cap-0', at: '2026-10-17T09:00:00Z' },
      },
    ],
  } as unknown as ProjectManifest;
  workspace.getState().openProject({ id: 'p-rf', root: '/p-rf', manifest });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <>
        <RfLayer />
        <CoverageGroup bench="display" />
      </>,
    );
  });
  await until(() => rfStore.getState().status === 'ready', 'store loaded');
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.setState({ project: null });
});

/** A setting change: the working copy has changes, so the live preview is shown. */
async function preview() {
  act(() => {
    patchSettings('ant-a', { etiltDeg: 6 });
  });
  await until(() => coverage.getState().preview !== null, 'preview');
  await wait();
}

describe('the Coverage layer', () => {
  it('draws the live preview on the map and in the 3D view, and fills the class table', async () => {
    expect(map.sources.has(COVERAGE_SOURCE)).toBe(false);
    await preview();
    expect(rfStore.getState().preview.status).toBe('ready');
    expect(map.layers.get(COVERAGE_LAYER)?.layout.visibility).toBe('visible');
    expect(map.layers.get(COVERAGE_LAYER)?.paint['raster-opacity']).toBe(0.6);
    expect(map.layers.get(BORESIGHT_LAYER)).toBeDefined();
    const group = scene.scene.getObjectByName(SCENE_GROUP) as Group;
    expect(group.visible).toBe(true);
    expect(group.children.some((c) => c instanceof Mesh)).toBe(true);
    expect(rfStore.getState().classStats?.length).toBe(5);
    expect(host.querySelector('[data-testid="display-coverage-what"]')?.textContent).toBe(
      'Live preview, RSRP',
    );
  });

  it('hides the map layer and the 3D drape together with the eye', async () => {
    await preview();
    const eye = host.querySelector<HTMLButtonElement>('[data-testid="display-coverage-eye"]');
    if (!eye) throw new Error('no eye');
    act(() => {
      eye.click();
    });
    expect(rfLayer.getState().visible).toBe(false);
    expect(map.layers.get(COVERAGE_LAYER)?.layout.visibility).toBe('none');
    expect(map.layers.get(BORESIGHT_LAYER)?.layout.visibility).toBe('none');
    expect((scene.scene.getObjectByName(SCENE_GROUP) as Group).visible).toBe(false);
    act(() => {
      eye.click();
    });
    expect(map.layers.get(COVERAGE_LAYER)?.layout.visibility).toBe('visible');
    expect((scene.scene.getObjectByName(SCENE_GROUP) as Group).visible).toBe(true);
  });

  it('sets the opacity on both from the Display slider', async () => {
    await preview();
    const slider = host.querySelector<HTMLInputElement>('[data-testid="display-coverage-opacity"]');
    if (!slider) throw new Error('no slider');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '30');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(map.layers.get(COVERAGE_LAYER)?.paint['raster-opacity']).toBeCloseTo(0.3, 10);
    const mesh = (scene.scene.getObjectByName(SCENE_GROUP) as Group).children.find(
      (c): c is Mesh => c instanceof Mesh,
    );
    expect((mesh?.material as { opacity: number }).opacity).toBeCloseTo(0.3, 10);
  });

  it('applies the survey date line-up shift to the map image and the 3D drape', async () => {
    await preview();
    const g = coverage.getState().preview?.grid;
    if (!g) throw new Error('no grid');
    const mesh = (scene.scene.getObjectByName(SCENE_GROUP) as Group).children.find(
      (c): c is Mesh => c instanceof Mesh,
    );
    // the grid centre, moved 12 m east and 7 m south, in the local frame (x east, z south)
    const ce = g.originEast + (g.width * g.resolutionM) / 2;
    const cn = g.originNorth - (g.height * g.resolutionM) / 2;
    expect(mesh?.position.x).toBeCloseTo(ce + 12 - 500_000, 6);
    expect(mesh?.position.z).toBeCloseTo(-(cn - 7 - 2_700_000), 6);
    // the drape lies on the tower-base ground (groundZ 100 = the origin height), lifted a little
    expect(mesh?.position.y).toBeCloseTo(0.3, 6);
    const shifted = map.sources.get(COVERAGE_SOURCE)?.coordinates as [number, number][];

    // the same preview without the shift lies west and north of it
    act(() => {
      const p = workspace.getState().project;
      if (!p) throw new Error('no project');
      workspace.setState({
        project: { ...p, manifest: { ...p.manifest, captures: [] } },
      });
    });
    await wait();
    const plain = map.sources.get(COVERAGE_SOURCE)?.coordinates as [number, number][];
    expect(shifted[0]?.[0]).toBeGreaterThan(plain[0]?.[0] ?? 0);
    expect(shifted[0]?.[1]).toBeLessThan(plain[0]?.[1] ?? 0);
  });

  it('goes back to the chosen run (none here) when the changes are undone', async () => {
    await preview();
    await act(async () => {
      const { loadRf } = await import('./rfStore');
      await loadRf('p-rf');
    });
    await until(() => !map.sources.has(COVERAGE_SOURCE), 'cleared');
    expect(rfStore.getState().preview.status).toBe('idle');
    expect(rfStore.getState().classStats).toBeNull();
  });

  it('draws the picture under the boresight arrows, whichever came first', async () => {
    // the arrows' layer is there before any picture (the first draw has none)
    expect(map.order).toContain(BORESIGHT_LAYER);
    await preview();
    expect(map.order.indexOf(COVERAGE_LAYER)).toBeLessThan(map.order.indexOf(BORESIGHT_LAYER));
  });

  it('skips the preview of a study past the pixel cap, with no Worker, and keeps the run allowed', async () => {
    act(() => {
      // 15 km at 5 m: 6001 x 6001 pixels, past MAX_PREVIEW_PIXELS
      patchStudy({ radiusM: 15_000, gridResolutionM: 5 });
    });
    await until(() => rfStore.getState().preview.status === 'too-large', 'too large');
    await wait(200);
    expect(h.workers.started).toBe(0);
    expect(coverage.getState().preview).toBeNull();
    expect(map.sources.has(COVERAGE_SOURCE)).toBe(false);
    expect(rfStore.getState().check.refusals).not.toContain('too-large');
    // back under the cap: previewed again
    act(() => {
      patchStudy({ radiusM: 200, gridResolutionM: 20 });
    });
    await until(() => coverage.getState().preview !== null, 'preview again');
    expect(rfStore.getState().preview.status).toBe('ready');
    expect(h.workers.started).toBe(1);
  });

  it('closing the project resets the RF store and starts no Worker', async () => {
    // an unsaved edit, closed before its preview runs
    act(() => {
      patchSettings('ant-a', { etiltDeg: 6 });
    });
    expect(rfStore.getState().dirty).toBe(true);
    act(() => {
      workspace.getState().closeProject();
    });
    await wait(300);
    const s = rfStore.getState();
    expect(s.projectId).toBeNull();
    expect(s.dirty).toBe(false);
    expect(s.antennas).toBeNull();
    expect(s.sectors.antennas).toEqual([]);
    expect(h.workers.started).toBe(0);
    expect(coverage.getState()).toMatchObject({ run: null, preview: null, previewSources: [] });
    expect(map.sources.has(COVERAGE_SOURCE)).toBe(false);
  });

  it('closing the project puts a running preview Worker away and keeps the pack', async () => {
    act(() => {
      rfStore.setState({ pack: { state: 'ok', version: '1.0.0' } });
    });
    await preview();
    expect(h.workers).toEqual({ started: 1, terminated: 0 });
    act(() => {
      workspace.getState().closeProject();
    });
    await wait(300);
    expect(h.workers).toEqual({ started: 1, terminated: 1 });
    expect(rfStore.getState().projectId).toBeNull();
    expect(rfStore.getState().pack).toEqual({ state: 'ok', version: '1.0.0' });
  });

  it('puts the preview Worker away and starts a new one for another project', async () => {
    await preview();
    expect(h.workers).toEqual({ started: 1, terminated: 0 });
    act(() => {
      workspace.getState().openProject({ id: 'p-rf-2', root: '/p-rf-2', manifest: threeDates });
    });
    await until(() => rfStore.getState().projectId === 'p-rf-2', 'second project');
    expect(h.workers.terminated).toBe(1);
    expect(coverage.getState().preview).toBeNull();
  });
});

describe('a project that opens with runs', () => {
  it('shows its newest finished run once, and a later "No run chosen" stays', async () => {
    const r = (runId: string, createdAt: string, status: 'done' | 'failed') => ({
      runId,
      createdAt,
      status,
    });
    act(() => {
      root.unmount();
    });
    resetRf();
    h.runs = [
      r('rf-failed', '2026-10-17T12:00:00Z', 'failed'),
      r('rf-new', '2026-10-17T11:00:00Z', 'done'),
      r('rf-old', '2026-10-17T10:00:00Z', 'done'),
    ];
    workspace.getState().openProject({ id: 'p-runs', root: '/p-runs', manifest: threeDates });
    root = createRoot(host);
    act(() => {
      root.render(<RfLayer />);
    });
    await until(() => rfStore.getState().selectedRunId !== null, 'selected');
    expect(rfStore.getState().selectedRunId).toBe('rf-new');
    const { selectRun, refreshRuns } = await import('./rfStore');
    await act(async () => {
      await selectRun(null);
      await refreshRuns();
    });
    await wait(50);
    expect(rfStore.getState().selectedRunId).toBeNull();
  });
});

describe('the DSM ground', () => {
  it('samples the DSM around the tower where it is drawn, line-up shift applied', async () => {
    act(() => {
      root.unmount();
    });
    resetRf();
    h.rays = [];
    const file = antennasFile([unit('ant-a', 0)], null);
    h.antennas = { ...file, run: { ...file.run, captureId: 'cap-1' } };
    const p = workspace.getState().project;
    if (!p) throw new Error('no project');
    const manifest = {
      ...p.manifest,
      layers: [
        ...p.manifest.layers,
        {
          kind: 'raster',
          id: 'dsm-1',
          name: 'DSM',
          role: 'dsm',
          format: 'cog',
          src: { path: 'dsm.tif' },
          corners: { tl: [0, 0, 0], tr: [1, 0, 0], bl: [0, 0, 1] },
        },
      ],
    } as unknown as ProjectManifest;
    workspace.getState().openProject({ id: 'p-dsm', root: '/p-dsm', manifest });
    root = createRoot(host);
    act(() => {
      root.render(<RfLayer />);
    });
    await until(() => rfStore.getState().rows[0]?.height.basis === 'estimated', 'estimated height');
    // the unit at E 500000, N 2700000 drawn 12 m east and 7 m south: local x 12, z 7
    const mean = (k: 0 | 1) => h.rays.reduce((a, r) => a + r[k], 0) / h.rays.length;
    expect(mean(0)).toBeCloseTo(12, 6);
    expect(mean(1)).toBeCloseTo(7, 6);
    // the DSM at 5 m local is 105 m: the box centre at 131.5 m is 26.5 m above it
    expect(rfStore.getState().rows[0]?.height.heightM).toBeCloseTo(26.5, 6);
  });
});
