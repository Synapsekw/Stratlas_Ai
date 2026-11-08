// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { volumetric, type Volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { measureStore } from '../survey/measureStore';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import { workbench } from '../workspace/workbench/workbenchStore';
import { layoutPrefs } from './layoutStore';
import { chooseStrip, useApplyPreset, useLayout, useStrip } from './useApplyPreset';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fusion project with no purpose: data fusion, or a survey once it holds piles. */
const fusion = { ...threeDates, type: 'fusion' } as unknown as ProjectManifest;
/** A survey with a video and three dates: Volume over time leads, Footage is the switch's other side. */
const survey = { ...threeDates, purpose: 'survey' } as unknown as ProjectManifest;
/** No type and no purpose (an imported kit project): a survey once it holds piles, else inspection. */
const untyped = {
  ...threeDates,
  type: undefined,
  purpose: undefined,
} as unknown as ProjectManifest;
const PILE = [{ id: 'pile-1' }] as unknown as Volumetric['piles'];

/** The tab of the preset the readers see (null: no layout yet for this open). */
const probe: { seen: string | null; strip: string | null } = { seen: null, strip: null };
function Probe() {
  useApplyPreset();
  const layout = useLayout();
  const tab = layout ? layout.preset.rightTab : null;
  const strip = useStrip();
  useEffect(() => {
    probe.seen = tab;
    probe.strip = strip;
  });
  return null;
}

let host: HTMLDivElement;
let root: Root | undefined;
const load = vi.fn(() => Promise.resolve());

/** What the stores beside the manifest hold, for `projectId`. */
function stores(projectId: string, piles: boolean, status: Volumetric['status'] = 'ready') {
  act(() => {
    volumetric.setState({ projectId, status, piles: piles ? PILE : [] });
    measureStore.setState({ projectId, status: 'ready' });
  });
}

function open(id: string, manifest: ProjectManifest = fusion) {
  act(() => {
    workspace.getState().openProject({ id, root: `/${id}`, manifest });
    workbench.getState().reset();
  });
}

beforeEach(() => {
  probe.seen = null;
  probe.strip = null;
  load.mockClear();
  volumetric.setState({ load });
  layoutPrefs.setState({ byProject: {}, chosen: null });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  act(() => {
    workspace.getState().closeProject();
  });
});

function render() {
  root = createRoot(host);
  act(() => {
    root?.render(<Probe />);
  });
}

describe('useApplyPreset', () => {
  it("applies B's preset only once B's own data is read, never with A's piles", () => {
    open('a');
    stores('a', true);
    render();
    // A: a fusion project with piles opens as a survey, on Project
    expect(probe.seen).toBe('project');
    expect(workbench.getState().panel).toBe('project');
    // B opens while the stores still hold A's piles: nothing applies yet
    open('b');
    expect(probe.seen).toBeNull();
    expect(layoutPrefs.getState().chosen?.projectId).not.toBe('b');
    // B's stores read, no piles: data fusion, on Layers & display
    stores('b', false);
    expect(layoutPrefs.getState().chosen).toEqual({ projectId: 'b', purpose: 'data-fusion' });
    expect(probe.seen).toBe('layers');
    expect(workbench.getState().panel).toBe('layers');
  });

  it('A, then B before its data is read, then A again applies A once more', () => {
    open('a');
    stores('a', true);
    render();
    expect(workbench.getState().panel).toBe('project');
    // B opens while the stores still hold A's piles: B's layout waits
    open('b');
    expect(probe.seen).toBeNull();
    // back to A before B's stores settle: the stores hold A's data, so A's layout applies again
    open('a');
    expect(probe.seen).toBe('project');
    expect(workbench.getState().panel).toBe('project');
  });

  it('a reload of the piles mid-session does not change the preset', () => {
    open('c');
    stores('c', true);
    render();
    expect(layoutPrefs.getState().chosen?.purpose).toBe('survey');
    // the volumes reload (a manifest change): loading, then no piles for a moment
    stores('c', false, 'loading');
    stores('c', false);
    expect(layoutPrefs.getState().chosen?.purpose).toBe('survey');
    expect(probe.seen).toBe('project');
  });

  it('the strip a survey shows before its stores are read is the one it settles on', () => {
    // another project's stores, still loading: the survey's layout waits for its own
    stores('other', false, 'loading');
    open('s', survey);
    render();
    expect(probe.seen).toBeNull();
    // Volume over time waits for the piles: the dates side, as after the settle
    expect(probe.strip).toBe('dates');
    stores('s', true);
    expect(probe.seen).toBe('project');
    expect(probe.strip).toBe('volume');
  });

  it('Footage picked before a slow settle holds through it', () => {
    stores('other', false, 'loading');
    open('t', survey);
    render();
    act(() => {
      chooseStrip('footage');
    });
    // the pick shows at once, not only once the stores are read
    expect(probe.strip).toBe('footage');
    stores('t', true);
    expect(layoutPrefs.getState().chosen?.purpose).toBe('survey');
    expect(probe.strip).toBe('footage');
    // and a reload of the piles later does not move it either
    stores('t', false, 'loading');
    stores('t', true);
    expect(probe.strip).toBe('footage');
  });

  it('an untyped project with video and piles keeps one strip across the settle', () => {
    stores('other', false, 'loading');
    open('u', untyped);
    render();
    // its purpose waits on the piles: no side is guessed (Footage, then Dates, would be a jump)
    const before = probe.strip;
    stores('u', true);
    expect(layoutPrefs.getState().chosen?.purpose).toBe('survey');
    expect(probe.strip).toBe('volume');
    expect(before === null || before === 'volume' || before === 'dates').toBe(true);
  });

  it('an untyped project without piles keeps one strip across the settle', () => {
    stores('other', false, 'loading');
    open('w', untyped);
    render();
    const before = probe.strip;
    stores('w', false);
    expect(probe.strip).toBe('footage');
    expect(before === null || before === 'footage').toBe(true);
  });

  it('reads the volumes of a project already open when it mounts', () => {
    act(() => {
      volumetric.setState({ projectId: null, status: 'idle', piles: [] });
    });
    open('d');
    render();
    expect(load).toHaveBeenCalled();
  });

  it('saves a Layers column opened by hand as the wide default only in a wide window', () => {
    open('e');
    act(() => {
      shell.setState({ screen: 'scene', windowWidth: 1300, layersFoldWide: true });
    });
    act(() => {
      shell.setState({ layersFoldWide: false });
    });
    expect(layoutPrefs.getState().get('e').layersOpenWide).toBeUndefined();
    act(() => {
      shell.setState({ windowWidth: 1500, layersFoldWide: true });
    });
    act(() => {
      shell.setState({ layersFoldWide: false });
    });
    expect(layoutPrefs.getState().get('e').layersOpenWide).toBe(true);
  });
});
