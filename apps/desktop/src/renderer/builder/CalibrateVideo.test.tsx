// @vitest-environment jsdom
import type * as Video from '@aio/video';
import type { LensPair } from '@aio/video';
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Intersection } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scene = { projectId: 'p' };
vi.mock('@aio/engine', () => ({
  getActiveScene: () => scene,
  onActiveScene: () => () => undefined,
}));

/** The pairs the panel hands the fit, recorded. */
let fitted: readonly LensPair[] = [];
vi.mock('@aio/video', async (importOriginal) => ({
  ...(await importOriginal<typeof Video>()),
  videoRig: () => ({
    loggedPose: () => ({ pos: [0, 10, 0], q: [0, 0, 0, 1] }),
    flightOf: () => null,
  }),
  setCalibrationLens: () => undefined,
  setCalibrationOrientation: () => undefined,
  setCalibrationPosition: () => undefined,
  setCameraMode: () => undefined,
  setProjection: () => undefined,
  fitCalibration: (pairs: readonly LensPair[]) => {
    fitted = pairs;
    throw new Error('recorded');
  },
}));

let scenePick: ((hit: Intersection | null) => void) | null = null;
vi.mock('./pick', () => ({
  useStagePick: (armed: boolean, cb: (hit: Intersection | null) => void) => {
    scenePick = armed ? cb : null;
  },
}));

const { CalibrateVideo } = await import('./CalibrateVideo');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip: Layer = {
  kind: 'video',
  id: 'clip',
  name: 'Clip',
  visible: true,
  capture: 'd2',
  src: { path: 'video/clip.mp4' },
  flight: { src: { path: 'flights/clip.json' }, startUtcMs: 1_700_000_000_000 },
  lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.7778 },
  offsetMs: 0,
};
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [500000, 4000000, 10],
  captures: [
    {
      id: 'd2',
      label: 'Second',
      date: '2026-02-10',
      lineUp: { eastM: 2, northM: 1, with: 'd1', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [clip],
  severityModels: [],
  classCatalogues: [],
};

let host: HTMLDivElement;
let pane: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
  pane = document.createElement('div');
  pane.className = 'pane-3d';
  host = document.createElement('div');
  document.body.append(pane, host);
  fitted = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  pane.remove();
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Calibrate video on a lined-up date', () => {
  it("keeps a picked model point in the clip's own frame, so the fitted offset reloads in place", () => {
    workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
    act(() => {
      root = createRoot(host);
      root.render(<CalibrateVideo layerId="clip" />);
    });
    const pick = (x: number, z: number) => {
      act(() => q('add-pair')?.click());
      act(() => {
        q('calibration-frame')?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
        );
      });
      expect(scenePick).not.toBeNull();
      act(() => {
        scenePick?.({ point: { x, y: 0, z } } as unknown as Intersection);
      });
    };
    // the points are picked where the date is drawn: 2 m east and 1 m north of its own frame
    pick(12, -21);
    pick(32, -41);
    act(() => q('fit-lens')?.click());
    expect(fitted.map((p) => p.world)).toEqual([
      [10, 0, -20],
      [30, 0, -40],
    ]);
  });
});
