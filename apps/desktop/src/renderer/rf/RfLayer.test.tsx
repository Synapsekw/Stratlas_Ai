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
import { patchSettings, resetRf, rfStore } from './rfStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  antennas: null as AntennasFile | null,
  sectors: null as RfSectorsFile | null,
  map: null as object | null,
  scene: null as object | null,
}));

vi.mock('../shell', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellModule>()),
  bridge: {
    call: vi.fn((channel: string) => {
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
          return Promise.resolve({ ok: true, value: { ok: true, runs: [] } });
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
      const client: PreviewClientPort = {
        onmessage: null,
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
    addLayer: (l: {
      id: string;
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }) => {
      layers.set(l.id, { layout: { ...l.layout }, paint: { ...l.paint } });
    },
    removeLayer: (id: string) => layers.delete(id),
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
  return { ctl: { map }, sources, layers };
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
});
