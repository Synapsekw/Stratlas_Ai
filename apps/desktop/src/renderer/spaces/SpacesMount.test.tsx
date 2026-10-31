// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import type { Issue } from '@aio/schema';
import { ProjectManifest } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  load: vi.fn<(...a: unknown[]) => Promise<Float32Array | null>>(),
  issues: [] as { id: string; sightings: { layer: string }[] }[],
}));
// the register itself is covered in @aio/annotate: here it lists what its issueFilter lets through
vi.mock('@aio/annotate', async (orig: () => Promise<Record<string, unknown>>) => ({
  ...(await orig()),
  IssueRegister: ({ issueFilter }: { issueFilter?: (i: Issue) => boolean }) => (
    <ul data-testid="issue-register">
      {h.issues
        .filter((i) => (issueFilter ?? (() => true))(i as unknown as Issue))
        .map((i) => (
          <li key={i.id}>{i.id}</li>
        ))}
    </ul>
  ),
}));
vi.mock('../flyability/flightlineModel', async (orig: () => Promise<Record<string, unknown>>) => ({
  ...(await orig()),
  loadFlightline: h.load,
}));
// the shell's module graph is large: a small store with the two things the mount reads
interface FakeShell {
  stageMode: string;
  setStageMode(m: string): void;
}
const shellStore = createStore<FakeShell>()((set) => ({
  stageMode: '3d',
  setStageMode: (stageMode) => {
    set({ stageMode });
  },
}));
vi.mock('../shell', () => ({
  shell: shellStore,
  useShell: <T,>(sel: (s: FakeShell) => T) => useStore(shellStore, sel),
}));

const { SpacesMount } = await import('./SpacesMount');
const { IssuesScreen } = await import('../screens/Issues');
const { setActiveSpace } = await import('./activeSpace');
const { stagePrefs } = await import('../workspace/stagePrefs');
const { FLIGHTLINE_GROUP } = await import('../flyability/flightlineScene');

const photos = (id: string, space?: string) => ({
  kind: 'photos' as const,
  id,
  name: id,
  items: [],
  ...(space ? { space } : {}),
});
const flight = (id: string, space: string) => ({
  kind: 'flightline' as const,
  id,
  name: id,
  space,
  src: { path: `imports/${id}.json` },
  flight: id,
  bootStartS: 0,
});
const base = {
  schema: 'aio.project/1' as const,
  id: 'p1',
  name: 'Tank survey',
  crs: { epsg: 32640 },
  origin: [10, 20, 30] as [number, number, number],
  captures: [],
  severityModels: [],
  classCatalogues: [],
};
const withSpaces = (layers: unknown[]) =>
  ProjectManifest.parse({
    ...base,
    layers,
    spaces: [{ id: 's-a', name: 'Inside', crs: { local: 'flyability' }, origin: [0, 0, 0] }],
  });

let root: Root | undefined;
let scene: Scene;
const mount = (stage: EngineStage | null) => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => {
    root?.render(<SpacesMount stage={stage} />);
  });
};
const open = (m: ProjectManifest) => {
  act(() => {
    workspace.getState().openProject({ id: 'p1', root: 'r', manifest: m });
  });
};
const stage = () => {
  scene = new Scene();
  return { scene, requestRender: vi.fn() } as unknown as EngineStage;
};
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const line = new Float32Array([0, 0, 0, 1, 0, 0]);

beforeEach(() => {
  h.load.mockReset();
  h.load.mockResolvedValue(line);
  shellStore.setState({ stageMode: '3d' });
  clearToasts();
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = '';
});

describe('SpacesMount', () => {
  it('switching space hides the other space layers', () => {
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 'main');
    mount(null);
    expect(workspace.getState().hidden).toEqual({ la: true });
    act(() => {
      setActiveSpace('p1', 's-a');
    });
    expect(workspace.getState().hidden).toEqual({ lm: true });
  });

  it('a local space never stays on the map view', () => {
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 's-a');
    shellStore.setState({ stageMode: 'map' });
    mount(null);
    expect(shellStore.getState().stageMode).toBe('3d');
    // the greyed Map button explains it: no toast
    expect(toastQueue().some((x) => x.id === 'fly-map-local')).toBe(false);
  });

  it('a local space never stays on a split that shows the map', () => {
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 's-a');
    stagePrefs.getState().update('p1', { split: undefined });
    shellStore.setState({ stageMode: 'split' });
    mount(null);
    expect(shellStore.getState().stageMode).toBe('3d');
    // a photo with the map beside it, set later
    act(() => {
      stagePrefs.getState().update('p1', { split: { left: 'map', right: 'photo' } });
      shellStore.getState().setStageMode('split');
    });
    expect(shellStore.getState().stageMode).toBe('3d');
  });

  it('splits without the map survive in a local space', () => {
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 's-a');
    mount(null);
    for (const split of [
      { left: '3d', right: 'photo' },
      { left: 'pano', right: '3d' },
      // a comparison of two dates
      { left: '3d', right: '3d', leftCapture: 'c1', rightCapture: 'c2' },
    ] as const) {
      act(() => {
        stagePrefs.getState().update('p1', { split });
        shellStore.getState().setStageMode('split');
      });
      expect(shellStore.getState().stageMode).toBe('split');
    }
    stagePrefs.getState().update('p1', { split: undefined });
  });

  it('a project in a crs the map cannot project stays on the map view', () => {
    for (const crs of [{ epsg: 2229 }, { wkt: 'PROJCS["Custom grid",GEOGCS["WGS 84"]]' }]) {
      open(ProjectManifest.parse({ ...base, crs, layers: [photos('l1')] }));
      setActiveSpace('p1', 'main');
      shellStore.setState({ stageMode: 'map' });
      mount(null);
      expect(shellStore.getState().stageMode).toBe('map');
      expect(toastQueue().some((x) => x.id === 'fly-map-local')).toBe(false);
      act(() => {
        root?.unmount();
      });
      root = undefined;
    }
  });

  it('a local project without listed spaces has no map either', () => {
    open(ProjectManifest.parse({ ...base, crs: { local: 'site' }, layers: [photos('l1')] }));
    setActiveSpace('p1', 'main');
    shellStore.setState({ stageMode: 'map' });
    mount(null);
    expect(shellStore.getState().stageMode).toBe('3d');
  });

  it('an empty flight-line list is not redrawn', () => {
    open(withSpaces([photos('lm'), photos('l2')]));
    setActiveSpace('p1', 'main');
    const render = vi.fn();
    scene = new Scene();
    const st = { scene, requestRender: render } as unknown as EngineStage;
    mount(st);
    act(() => {
      workspace.getState().setLayersVisible(['l2'], false);
    });
    act(() => {
      workspace.getState().setLayersVisible(['l2'], true);
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('a hidden flight line is not drawn', async () => {
    open(withSpaces([flight('f1', 's-a'), flight('f2', 's-a')]));
    setActiveSpace('p1', 's-a');
    act(() => {
      workspace.getState().setLayersVisible(['f2'], false);
    });
    mount(stage());
    await flush();
    const group = scene.getObjectByName(FLIGHTLINE_GROUP);
    expect(group?.children.map((c) => (c.userData as { layerId: string }).layerId)).toEqual(['f1']);
  });

  it('a project without flight lines draws nothing and loads nothing', async () => {
    open(withSpaces([photos('lm')]));
    setActiveSpace('p1', 'main');
    mount(stage());
    await flush();
    expect(h.load).not.toHaveBeenCalled();
    expect(scene.getObjectByName(FLIGHTLINE_GROUP)?.children ?? []).toHaveLength(0);
  });
  it('an import into another space stays hidden', () => {
    const m = withSpaces([photos('lm'), photos('la', 's-a')]);
    open(m);
    setActiveSpace('p1', 'main');
    mount(null);
    act(() => {
      workspace
        .getState()
        .replaceManifest(withSpaces([photos('lm'), photos('la', 's-a'), photos('lb', 's-a')]));
    });
    expect(workspace.getState().hidden).toEqual({ la: true, lb: true });
  });

  it('a date jump cannot show another space layer', () => {
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 'main');
    mount(null);
    act(() => {
      workspace.getState().applyVisibility(['la'], []);
    });
    expect(workspace.getState().hidden).toEqual({ la: true });
  });

  it('a single-space project makes no visibility call', () => {
    open(ProjectManifest.parse({ ...base, layers: [photos('l1')] }));
    const spy = vi.spyOn(workspace.getState(), 'applyVisibility');
    setActiveSpace('p1', 'main');
    mount(null);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('going there and back restores what was hidden in each space', () => {
    open(withSpaces([photos('lm'), photos('lm2'), photos('la', 's-a')]));
    setActiveSpace('p1', 'main');
    mount(null);
    act(() => {
      workspace.getState().setLayersVisible(['lm2'], false);
    });
    act(() => {
      setActiveSpace('p1', 's-a');
    });
    expect(workspace.getState().hidden).toEqual({ lm: true, lm2: true });
    act(() => {
      setActiveSpace('p1', 'main');
    });
    expect(workspace.getState().hidden).toEqual({ la: true, lm2: true });
  });

  it('a layer saved hidden in the second space stays hidden when entering it', () => {
    open(
      withSpaces([photos('lm'), photos('la', 's-a'), { ...photos('lb', 's-a'), visible: false }]),
    );
    setActiveSpace('p1', 'main');
    mount(null);
    act(() => {
      setActiveSpace('p1', 's-a');
    });
    expect(workspace.getState().hidden).toEqual({ lm: true, lb: true });
  });

  it('the issue register shows only the active space', () => {
    h.issues = [
      { id: 'i-main', sightings: [{ layer: 'lm' }] },
      { id: 'i-in', sightings: [{ layer: 'la' }] },
    ];
    open(withSpaces([photos('lm'), photos('la', 's-a')]));
    setActiveSpace('p1', 's-a');
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => {
      root?.render(<IssuesScreen />);
    });
    const listed = () => [...host.querySelectorAll('li')].map((x) => x.textContent);
    expect(listed()).toEqual(['i-in']);
    act(() => {
      setActiveSpace('p1', 'main');
    });
    expect(listed()).toEqual(['i-main']);
  });

  it('a single-space project lists every issue', () => {
    h.issues = [
      { id: 'i1', sightings: [{ layer: 'l1' }] },
      { id: 'i2', sightings: [] },
    ];
    open(ProjectManifest.parse({ ...base, layers: [photos('l1')] }));
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => {
      root?.render(<IssuesScreen />);
    });
    expect([...host.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['i1', 'i2']);
  });
});
