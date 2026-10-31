// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
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
const { setActiveSpace } = await import('./activeSpace');
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
    expect(toastQueue().some((x) => x.id === 'fly-map-local')).toBe(true);
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
});
