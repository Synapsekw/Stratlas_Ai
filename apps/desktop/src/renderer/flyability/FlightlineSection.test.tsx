// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { FlightlineDraw } from './flightlineScene';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  load: vi.fn<(...a: unknown[]) => Promise<Float32Array | null>>(),
  draws: [] as FlightlineDraw[][],
}));
vi.mock('./flightlineModel', async (orig: () => Promise<Record<string, unknown>>) => ({
  ...(await orig()),
  loadFlightline: h.load,
}));
// what the 3D view was last told to draw
vi.mock('./flightlineScene', async (orig: () => Promise<Record<string, unknown>>) => {
  const real = (await orig()) as {
    attachFlightlines: (s: EngineStage) => { set: (l: FlightlineDraw[]) => void };
  };
  return {
    ...real,
    attachFlightlines: (stage: EngineStage) => {
      const view = real.attachFlightlines(stage);
      const set = view.set;
      view.set = (lines) => {
        h.draws.push([...lines]);
        set(lines);
      };
      return view;
    },
  };
});
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

const { SpacesMount } = await import('../spaces/SpacesMount');
const { FlightlineSection } = await import('./FlightlineSection');
const { setActiveSpace } = await import('../spaces/activeSpace');
const { createFlightlineDisplayStore, DEFAULT_DISPLAY, flightlineDisplay } =
  await import('./flightlineDisplay');

const flight = (id: string) => ({
  kind: 'flightline' as const,
  id,
  name: id,
  space: 's-a',
  src: { path: `imports/${id}.json` },
  flight: id,
  bootStartS: 0,
});
const manifest = () =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Tank survey',
    crs: { epsg: 32640 },
    origin: [10, 20, 30],
    captures: [],
    severityModels: [],
    classCatalogues: [],
    layers: [flight('f1'), flight('f2')],
    spaces: [{ id: 's-a', name: 'Inside', crs: { local: 'flyability' }, origin: [0, 0, 0] }],
  });

let root: Root | undefined;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const last = () => h.draws[h.draws.length - 1] ?? [];

beforeEach(async () => {
  h.draws.length = 0;
  h.load.mockReset();
  h.load.mockResolvedValue(new Float32Array([0, 0, 0, 1, 0, 0]));
  flightlineDisplay().setState({ byProject: {} });
  act(() => {
    workspace.getState().openProject({ id: 'p1', root: 'r', manifest: manifest() });
  });
  setActiveSpace('p1', 's-a');
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const stage = { scene: new Scene(), requestRender: vi.fn() } as unknown as EngineStage;
  act(() => {
    root?.render(
      <>
        <SpacesMount stage={stage} />
        <FlightlineSection />
      </>,
    );
  });
  await flush();
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = '';
});

describe('FlightlineSection', () => {
  it('changing the colour mode redraws the lines', async () => {
    const own = last().map((l) => l.colour);
    expect(own).toHaveLength(2);
    expect(new Set(own).size).toBe(2);
    act(() => q('flightline-colour-one')?.click());
    await flush();
    const one = last().map((l) => l.colour);
    expect(one).toHaveLength(2);
    expect(new Set(one).size).toBe(1);
    act(() => q('flightline-colour-flight')?.click());
    await flush();
    expect(last().map((l) => l.colour)).toEqual(own);
  });

  it('the line width reaches the drawn lines', async () => {
    expect(last().every((l) => l.widthPx === DEFAULT_DISPLAY.widthPx)).toBe(true);
    const range = q('flightline-width') as HTMLInputElement;
    act(() => {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      (desc?.set as ((this: HTMLInputElement, v: string) => void) | undefined)?.call(range, '6');
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(last().map((l) => l.widthPx)).toEqual([6, 6]);
  });

  it('selected flight only draws just the selected flight, never touching the manifest', async () => {
    const before = JSON.stringify(workspace.getState().project?.manifest);
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'f2', layer: 'f2' });
    });
    act(() => document.querySelector<HTMLElement>('[role="switch"]')?.click());
    await flush();
    expect(last().map((l) => l.id)).toEqual(['f2']);
    expect(JSON.stringify(workspace.getState().project?.manifest)).toBe(before);
  });

  it('the choices are remembered per project and survive blocked storage', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    } as unknown as Storage;
    const a = createFlightlineDisplayStore(storage);
    a.getState().patch('p1', { widthPx: 99, colourMode: 'one' });
    expect(a.getState().byProject.p1).toMatchObject({ widthPx: 8, colourMode: 'one' });
    const b = createFlightlineDisplayStore(storage);
    expect(b.getState().byProject.p1?.colourMode).toBe('one');
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const c = createFlightlineDisplayStore(blocked);
    expect(() => {
      c.getState().patch('p1', { activeOnly: true });
    }).not.toThrow();
    expect(c.getState().byProject.p1?.activeOnly).toBe(true);
  });
});
