// @vitest-environment jsdom
import type { HeightTiles } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareStore } from '../survey/compareStore';
import type * as CompareStoreModule from '../survey/compareStore';
import type { HeatGrid } from '../survey/engineProtocol';
import { activeHeat } from '../survey/heatScene';
import { measureStore } from '../survey/measureStore';
import { clearCutFillCache, cutFillPrefs, SITE_HEAT_CELLS } from '../survey/volumes/cutFill';
import { threeDates } from './__fixtures__/threeDates';
import { compareDates } from './dates/compareDates';
import {
  legendRangeM,
  siteCutFillQuestion,
  siteCutFillWanted,
  useSiteCutFill,
} from './stageCutFill';
import { stageShow } from './StageShow';

const site = vi.hoisted(() => vi.fn());
vi.mock('../survey/compareStore', async (importOriginal) => {
  const real = await importOriginal<typeof CompareStoreModule>();
  return { ...real, engineClient: () => ({ site }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const surface = (id: string, capture: string): HeightTiles =>
  ({
    id,
    capture,
    source: { kind: 'dsm' },
    fingerprint: `fp-${id}`,
    cellM: 0.5,
    bounds: [0, 0, 0, 100, 100, 10],
  }) as unknown as HeightTiles;
const SURFACES = [surface('s-sep', 'sep'), surface('s-oct', 'oct'), surface('s-nov', 'nov')];
const grid = (item: string): HeatGrid => ({
  item,
  x0: 0,
  y0: 0,
  cellM: 1,
  nx: 1,
  ny: 1,
  dz: new Float32Array([0.5]),
  z: new Float32Array([1]),
});
const ok = { item: 'site', status: 'ok', cutM3: 3, fillM3: 5, netM3: 2, totalM3: 8 };

const ON = { kit: false, active: true, surface: 'change', heatOn: true } as const;

describe('the whole-site cut and fill on the stage (state)', () => {
  it('is wanted only in a survey project with Show up on Cut & fill and the heat map on', () => {
    expect(siteCutFillWanted(ON)).toBe(true);
    expect(siteCutFillWanted({ ...ON, kit: true })).toBe(false);
    expect(siteCutFillWanted({ ...ON, active: false })).toBe(false);
    expect(siteCutFillWanted({ ...ON, surface: 'photo' })).toBe(false);
    expect(siteCutFillWanted({ ...ON, surface: 'elev' })).toBe(false);
    expect(siteCutFillWanted({ ...ON, heatOn: false })).toBe(false);
  });

  it('asks about the pair surfaces with the threshold, and nothing while a date is unprepared', () => {
    const base = {
      wanted: true,
      engineReady: true,
      pair: { from: 'oct', to: 'nov' },
      surfaces: SURFACES,
      thresholdM: 0.1,
    };
    const q = siteCutFillQuestion(base);
    expect(q?.refs.from).toEqual({ kind: 'survey', surface: 's-oct', capture: 'oct' });
    expect(q?.refs.to).toEqual({ kind: 'survey', surface: 's-nov', capture: 'nov' });
    expect(q?.thresholdM).toBe(0.1);
    expect(siteCutFillQuestion({ ...base, thresholdM: 0.3 })?.key).not.toBe(q?.key);
    expect(siteCutFillQuestion({ ...base, surfaces: SURFACES.slice(0, 2) })).toBeNull();
    expect(siteCutFillQuestion({ ...base, wanted: false })).toBeNull();
    expect(siteCutFillQuestion({ ...base, engineReady: false })).toBeNull();
    expect(siteCutFillQuestion({ ...base, pair: null })).toBeNull();
  });

  it('the legend spans the largest heat map stop, else 2 m', () => {
    expect(
      legendRangeM({
        stops: [
          { value: -1.5, color: '#b2182b' },
          { value: 0, color: '#f7f7f7' },
          { value: 1, color: '#2166ac' },
        ],
        stepped: false,
        inverted: false,
      }),
    ).toBe(1.5);
  });

  it('a focused measurement heat map wins over the whole site; without one the site draws', () => {
    const s = measureStore.getState();
    const heat = { show3d: true, show2d: true, contours: false, item: null };
    const siteGrid = grid('site');
    expect(activeHeat({ computed: {}, heat, siteHeat: siteGrid }, { ...s, focus: null })).toBe(
      siteGrid,
    );
    expect(activeHeat({ computed: {}, heat }, { ...s, focus: null })).toBeNull();
  });
});

let host: HTMLDivElement;
let root: Root | undefined;
const seen: { current: ReturnType<typeof useSiteCutFill> } = { current: null };
function Probe() {
  const v = useSiteCutFill();
  useEffect(() => {
    seen.current = v;
  });
  return null;
}
const render = () => {
  root ??= createRoot(host);
  act(() => root?.render(<Probe />));
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useSiteCutFill', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCutFillCache();
    site.mockReset();
    site.mockImplementation(() => Promise.resolve({ result: ok, grid: null, heat: grid('site') }));
    host = document.createElement('div');
    document.body.append(host);
    workspace.getState().openProject({ id: 'p', root: '/p', manifest: threeDates });
    compareStore.setState({
      status: 'ready',
      surfaces: SURFACES,
      siteHeat: null,
      heat: { show3d: false, show2d: false, contours: false, item: null },
    });
    compareDates.getState().reset(['sep', 'oct', 'nov']);
    stageShow.getState().reset();
    stageShow.getState().setActive(true);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    stageShow.getState().setActive(false);
    workspace.getState().closeProject();
    volumetric.setState({
      status: 'idle',
      file: null,
      surface: 'photo',
      swipe: false,
      change: null,
    });
    compareStore.setState({
      status: 'idle',
      surfaces: [],
      siteHeat: null,
      heat: { show3d: true, show2d: true, contours: false, item: null },
    });
  });

  const cutAndFill = () => {
    act(() => {
      compareStore.setState({ heat: { show3d: true, show2d: true, contours: false, item: null } });
      stageShow.getState().setSurface('change');
    });
  };

  it('Cut & fill without a pile runs the whole site between the default pair and draws it', async () => {
    render();
    expect(site).not.toHaveBeenCalled();
    cutAndFill();
    await flush();
    expect(site).toHaveBeenCalledTimes(1);
    const [req] = site.mock.calls[0] as [Record<string, unknown>];
    // no pair chosen: the survey before the date in focus (the latest) and it
    expect(req).toMatchObject({
      from: { capture: 'oct' },
      to: { capture: 'nov' },
      deadbandM: cutFillPrefs.getState().thresholdM,
      heat: SITE_HEAT_CELLS,
    });
    expect(compareStore.getState().siteHeat?.item).toBe('site');
    expect(seen.current).toEqual({ from: '2024-10-02', to: '2024-11-06', thresholdM: 0.1 });
  });

  it('follows the compare pair', async () => {
    render();
    act(() => {
      compareDates.getState().set('sep', 'nov');
    });
    cutAndFill();
    await flush();
    expect(site.mock.calls[0]?.[0]).toMatchObject({
      from: { capture: 'sep' },
      to: { capture: 'nov' },
    });
  });

  it('Photo turns it off and the legend goes', async () => {
    render();
    cutAndFill();
    await flush();
    expect(compareStore.getState().siteHeat).not.toBeNull();
    act(() => {
      stageShow.getState().setSurface('photo');
      compareStore.setState({
        heat: { show3d: false, show2d: false, contours: false, item: null },
      });
    });
    await flush();
    expect(compareStore.getState().siteHeat).toBeNull();
    expect(seen.current).toBeNull();
  });

  it('a kit project keeps its own Cut & fill: no whole-site run', async () => {
    volumetric.setState({ status: 'ready' });
    render();
    cutAndFill();
    await flush();
    expect(site).not.toHaveBeenCalled();
    expect(compareStore.getState().siteHeat).toBeNull();
  });
});
