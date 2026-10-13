// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectManifest, WalkRawPath, type JobRecord, type WalkLayer } from '@aio/schema';
import type { OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tools = vi.hoisted(() => {
  const tools: { status: { state: string } | null } = { status: { state: 'ok' } };
  return tools;
});

vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
  jobs: { getState: () => ({ jobs: [], start: vi.fn() }), subscribe: () => () => undefined },
  useJobs: <T,>(sel: (s: { jobs: unknown[] }) => T): T => sel({ jobs: [] }),
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));
vi.mock('../processingTools', () => ({
  useProcessingTools: <T,>(sel: (s: { status: unknown }) => T): T => sel({ status: tools.status }),
}));

import { workspace } from '@aio/workspace';
import { placeImagery } from './placeBasemap';
import { surfaceById } from './placeModel';
import { walkBadge } from './walkBadge';
import {
  createPlaceSession,
  createPlaceUi,
  createPlaceWalk,
  type PlaceWalkDeps,
  type WalkInputs,
} from './placeWalk';
import { PlaceWalkStrip } from './PlaceWalkStrip';

const raw = WalkRawPath.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../../../packages/schema/src/__fixtures__/walk/raw-path.synthetic.json',
      ),
      'utf8',
    ),
  ) as unknown,
);

const plan = (id: string, name: string, capture?: string) => ({
  kind: 'raster' as const,
  id,
  name,
  ...(capture ? { capture } : {}),
  src: { path: `drawings/${id}/plan.png` },
  role: 'plan' as const,
  format: 'image' as const,
  corners: {
    tl: [10, 2, 20] as [number, number, number],
    tr: [110, 2, 20] as [number, number, number],
    bl: [10, 2, 70] as [number, number, number],
  },
});

const walkLayer = (extra: Partial<WalkLayer> = {}): WalkLayer => ({
  kind: 'walk',
  id: 'walk-a',
  name: 'Walk A',
  visible: true,
  record: { path: 'walks/a/walk.json' },
  src: { path: 'walks/a/playback.mp4' },
  durationS: 62,
  ...extra,
});

/** A processed walk (its path computed), dated `c1` unless said otherwise. */
const walkWithPath = (extra: Partial<WalkLayer> = {}): WalkLayer =>
  walkLayer({ capture: 'c1', path: { raw: { path: 'walks/a/raw-path.json' } }, ...extra });
/** A walk never processed. */
const walkWithoutPath = (extra: Partial<WalkLayer> = {}): WalkLayer =>
  walkLayer({ capture: 'c1', ...extra });
/** A walk placed before on the model (two saved pins: no check). */
const placedWalk = (extra: Partial<WalkLayer> = {}): WalkLayer =>
  walkLayer({
    capture: 'c1',
    place: {
      pins: [
        { t: 0, surface: '@model', at: [0, 0] },
        { t: 62, surface: '@model', at: [40, -30] },
      ],
      yawOffsetDeg: 0,
      heightM: 1.7,
      quality: 'good',
      placedOn: '@model',
    },
    ...extra,
  });

function projectWith(walk: WalkLayer, crs = true): OpenProject {
  return {
    id: 'p',
    root: 'C:/p',
    manifest: ProjectManifest.parse({
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      crs: crs ? { epsg: 32633 } : { wkt: 'LOCAL_CS["local"]' },
      origin: [0, 0, 0],
      captures: [
        { id: 'c1', label: 'First', date: '2026-01-01' },
        { id: 'c2', label: 'Second', date: '2026-02-01' },
      ],
      layers: [plan('sheet-own', 'Ground floor', 'c1'), plan('sheet-loose', 'Site plan'), walk],
      severityModels: [],
      classCatalogues: [],
    }),
  };
}

let project: OpenProject;
let host: HTMLDivElement;
let root: Root;

interface OpenOpts extends Partial<PlaceWalkDeps> {
  crs?: boolean;
  /** The walk's inputs; default: the synthetic raw path when the walk has a path, else none. */
  inputs?: WalkInputs;
}

function setup(walk: WalkLayer, opts: OpenOpts = {}) {
  const { crs, inputs, ...over } = opts;
  project = projectWith(walk, crs ?? true);
  const ui = createPlaceUi();
  const session = createPlaceSession(ui);
  const replaceWalk = (patch: Partial<WalkLayer>) => {
    const m = project.manifest;
    project = {
      ...project,
      manifest: {
        ...m,
        layers: m.layers.map((l) => (l.id === walk.id ? ({ ...l, ...patch } as WalkLayer) : l)),
      },
    };
  };
  const read: WalkInputs =
    inputs ?? (walk.path ? { raw, orientation: null } : { raw: null, orientation: null });
  const openSurface = vi.fn();
  const deps = {
    project: () => project,
    drawings: () => ({ provisional: false, size: { width: 1000, height: 500 } }),
    loadInputs: vi.fn(() => Promise.resolve(read)),
    openSurface,
    save: vi.fn(
      (_id: string, patch: Parameters<PlaceWalkDeps['save']>[1]): Promise<string | null> => {
        if ('walk' in patch && patch.walk) replaceWalk({ place: patch.walk });
        return Promise.resolve(null);
      },
    ),
    ensureCapture: vi.fn((day: string) => {
      const id = `capture-${day}`;
      project = {
        ...project,
        manifest: {
          ...project.manifest,
          captures: [...project.manifest.captures, { id, label: 'Survey', date: day }],
        },
      };
      return Promise.resolve({ captureId: id });
    }),
    setCapture: vi.fn((_id: string, capture: string) => {
      replaceWalk({ capture });
      return Promise.resolve(null);
    }),
    capturedAt: (): string | undefined => undefined,
    job: (): (Pick<JobRecord, 'status' | 'progress'> & { id?: string }) | undefined => undefined,
    modelSurface: (): 'map' | '3d' => '3d',
    process: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    ...over,
  } satisfies PlaceWalkDeps;
  const flow = createPlaceWalk(deps, session, ui);
  return { deps, flow, session, ui, openSurface };
}

type Ctx = ReturnType<typeof setup>;

/** Begin placing `walk` on the 3D view and show the strip. */
async function open(walk: WalkLayer, opts: OpenOpts = {}): Promise<Ctx> {
  act(() => {
    root.unmount();
  });
  root = createRoot(host);
  const ctx = setup(walk, opts);
  await act(async () => {
    await ctx.flow.begin('walk-a');
  });
  act(() => {
    const scene = surfaceById(ctx.flow.surfaces(), '3d');
    if (scene) ctx.flow.chooseSurface(scene);
  });
  act(() => {
    root.render(<PlaceWalkStrip flow={ctx.flow} session={ctx.session} ui={ctx.ui} />);
  });
  return ctx;
}

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const byTest = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const field = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const strip = () => byTest('walk-place-strip');
const hint = () => byTest('walk-place-hint')?.textContent;
const click = (el: Element | null) => {
  act(() => {
    (el as HTMLElement | null)?.click();
  });
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const choose = (value: string) => {
  const sel = host.querySelector<HTMLSelectElement>('[data-testid="walk-place-on"]');
  if (!sel) throw new Error('no Place on');
  act(() => {
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
/** Start and end on the 3D view, 50 m apart. */
const twoPins = (ctx: Ctx) => {
  act(() => {
    ctx.session.getState().click([0, 0], 0);
  });
  act(() => {
    ctx.session.getState().click([40, -30], 0);
  });
};
const noDialog = () => {
  expect(host.querySelector('[role="dialog"], dialog, [aria-modal]')).toBeNull();
};

const SAY_START = 'Click where the walk started. Its shape follows the pointer.';

beforeEach(() => {
  tools.status = { state: 'ok' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('PlaceWalkStrip: the path check', () => {
  it('a walk with no path shows the notice with Process walk and Place anyway, and no line', async () => {
    await open(walkWithoutPath(), { job: () => ({ status: 'interrupted', progress: 0.31 }) });
    const notice = q('[data-testid="walk-place-notice"]');
    expect(notice?.getAttribute('data-state')).toBe('interrupted');
    expect(notice?.textContent).toContain('Processing stopped before the path was computed.');
    expect(strip()?.getAttribute('data-step')).toBe('check');
    expect(byTest('walk-place-process')?.textContent).toBe('Process again');
    // nothing to save from the notice, and no fine-tune pins
    expect(byTest('walk-place-save')).toBeNull();
    expect(byTest('walk-place-pin-here')).toBeNull();
    click(byTest('walk-place-anyway'));
    expect(strip()?.getAttribute('data-step')).toBe('start');
    expect(q('[data-testid="walk-place-notice"]')).toBeNull();
  });

  it('Process walk on a walk never processed', async () => {
    const process = vi.fn(() => Promise.resolve(null));
    await open(walkWithoutPath(), { process });
    expect(byTest('walk-place-notice')?.getAttribute('data-state')).toBe('none');
    expect(byTest('walk-place-process')?.textContent).toBe('Process walk');
    // the one way forward from the notice is the primary action
    expect(
      [...host.querySelectorAll('.primary')].map((b) => b.getAttribute('data-testid')),
    ).toEqual(['walk-place-process']);
    click(byTest('walk-place-process'));
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('a processing walk says so and offers no second run', async () => {
    await open(walkWithoutPath(), { job: () => ({ status: 'running', progress: 0.4 }) });
    expect(byTest('walk-place-notice')?.textContent).toContain(
      'This walk is processing. Its shape appears here when it finishes.',
    );
    expect(byTest('walk-place-process')).toBeNull();
    expect(byTest('walk-place-anyway')).not.toBeNull();
  });

  it('without the pipeline pack Process walk is disabled and says why', async () => {
    tools.status = null;
    await open(walkWithoutPath());
    const btn = byTest('walk-place-process');
    expect(btn?.disabled).toBe(true);
    const why = btn?.getAttribute('aria-describedby');
    expect(why ? document.getElementById(why)?.textContent : null).toBe(
      'Needs a newer pipeline pack',
    );
  });

  it('why Process walk did not start shows beside the notice sentence', async () => {
    await open(walkWithoutPath(), {
      process: () => Promise.resolve('The original video is not found'),
    });
    click(byTest('walk-place-process'));
    await flush();
    expect(hint()).toBe(
      'This walk is not processed yet, so its path is unknown. The original video is not found',
    );
    expect(q('[data-testid="walk-place-notice"] .wplace-problem')?.textContent).toBe(
      'The original video is not found',
    );
  });

  it('pins-only note once placed anyway, none for a walk with a path', async () => {
    await open(walkWithoutPath());
    expect(byTest('walk-place-pins-only')).toBeNull();
    click(byTest('walk-place-anyway'));
    expect(byTest('walk-place-pins-only')?.textContent).toBe(
      'Path not computed: the walk is placed between your two points.',
    );
    await open(walkWithPath());
    expect(byTest('walk-place-pins-only')).toBeNull();
  });
});

describe('PlaceWalkStrip: placing', () => {
  it('Esc on End takes the start back', async () => {
    const { session } = await open(walkWithPath());
    act(() => {
      session.getState().click([0, 0], 0);
    });
    expect(strip()?.getAttribute('data-step')).toBe('end');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(strip()?.getAttribute('data-step')).toBe('start');
    expect(session.getState().pins).toEqual([]);
    expect(hint()).toBe(SAY_START);
    // an Escape another handler took (a 3D drag) leaves the start alone
    act(() => {
      session.getState().click([0, 0], 0);
    });
    act(() => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      e.preventDefault();
      window.dispatchEvent(e);
    });
    expect(strip()?.getAttribute('data-step')).toBe('end');
  });

  it('Esc on End from inside a field leaves the start alone', async () => {
    const { session } = await open(walkWithPath());
    act(() => {
      session.getState().click([0, 0], 0);
    });
    for (const tag of ['input', 'textarea', 'select'] as const) {
      const field = document.createElement(tag);
      document.body.append(field);
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });
      field.remove();
    }
    expect(strip()?.getAttribute('data-step')).toBe('end');
    expect(session.getState().pins).toHaveLength(1);
  });

  it('the hint follows the steps and says when the end is too close', async () => {
    const { session } = await open(walkWithPath());
    expect(strip()?.getAttribute('data-step')).toBe('start');
    expect(hint()).toBe(SAY_START);
    act(() => {
      session.getState().click([0, 0], 0);
    });
    expect(hint()).toBe('Click where the walk ended. Esc moves the start.');
    act(() => {
      session.getState().hover([2, 0], 0);
    });
    expect(hint()).toBe('Put the end at least 5 m from the start.');
    act(() => {
      session.getState().click([40, -30], 0);
    });
    expect(hint()).toBe('Drag Start or End to adjust the walk, then Save.');
    act(() => {
      session.getState().dragHandle('end', [1, 0], 0);
    });
    expect(hint()).toBe('Start and End stay at least 5 m apart.');
    act(() => {
      session.getState().endDrag();
    });
    expect(hint()).toBe('Drag Start or End to adjust the walk, then Save.');
  });

  it('a session error shows in the hint', async () => {
    const { session } = await open(walkWithPath());
    act(() => {
      session.setState({ error: 'The pins do not fit the walk' });
    });
    expect(hint()).toBe('The pins do not fit the walk');
    expect(byTest('walk-place-hint')?.getAttribute('role')).toBe('status');
  });

  it('the date field shows only for an undated walk and is preselected', async () => {
    const ctx = await open(walkWithPath({ capture: undefined }));
    const date = host.querySelector<HTMLSelectElement>('[data-testid="walk-place-date-field"]');
    expect(date?.value).toBe('c1');
    act(() => {
      if (!date) return;
      date.value = 'c2';
      date.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(ctx.ui.getState().date).toBe('c2');
    await open(walkWithPath({ capture: 'c1' }));
    expect(q('[data-testid="walk-place-date-field"]')).toBeNull();
  });

  it('the date field offers a day to add from the camera', async () => {
    const ctx = await open(walkWithPath({ capture: undefined }), {
      capturedAt: () => '2026-03-05T08:30:00',
    });
    const date = host.querySelector<HTMLSelectElement>('[data-testid="walk-place-date-field"]');
    const labels = [...(date?.options ?? [])].map((o) => o.textContent);
    expect(labels).toContain('Add survey date 5 Mar 2026');
    twoPins(ctx);
    act(() => {
      if (!date) return;
      date.value = 'add:2026-03-05';
      date.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      byTest('walk-place-save')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ctx.deps.ensureCapture).toHaveBeenCalledWith('2026-03-05');
    expect(ctx.deps.setCapture).toHaveBeenCalledWith('walk-a', 'capture-2026-03-05');
  });

  it('Place on lists drawings, Map and 3D view; choosing one opens it', async () => {
    const ctx = await open(walkWithPath());
    const options = [...host.querySelectorAll('[data-testid="walk-place-on"] option')]
      .filter((o) => !(o as HTMLOptionElement).disabled)
      .map((o) => o.textContent);
    expect(options).toEqual(['Ground floor', 'Site plan', 'Map', '3D view']);
    ctx.openSurface.mockClear();
    choose('sheet-loose');
    expect(ctx.openSurface).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({ kind: 'drawing', id: 'sheet-loose' }),
      false,
    );
    expect(ctx.ui.getState().host).toMatchObject({ kind: 'drawing', id: 'sheet-loose' });
    choose('map');
    expect(ctx.openSurface).toHaveBeenLastCalledWith('walk-a', { kind: 'map' }, false);
    const values = [...host.querySelectorAll('[data-testid="walk-place-on"] option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('offers no Map without a coordinate system', async () => {
    await open(walkWithPath(), { crs: false });
    const options = [...host.querySelectorAll('[data-testid="walk-place-on"] option')].map(
      (o) => o.textContent,
    );
    expect(options).not.toContain('Map');
  });

  it('Save is the one primary action and waits for both ends', async () => {
    const ctx = await open(walkWithPath());
    const primaries = () =>
      [...host.querySelectorAll('.primary')].map((b) => b.getAttribute('data-testid'));
    expect(primaries()).toEqual(['walk-place-save']);
    expect(byTest('walk-place-save')?.disabled).toBe(true);
    act(() => {
      ctx.session.getState().click([0, 0], 0);
    });
    expect(byTest('walk-place-save')?.disabled).toBe(true);
    act(() => {
      ctx.session.getState().click([40, -30], 0);
    });
    expect(byTest('walk-place-save')?.disabled).toBe(false);
  });

  it('Save waits for a change to a saved placement', async () => {
    const ctx = await open(placedWalk());
    expect(strip()?.getAttribute('data-step')).toBe('placed');
    expect(byTest('walk-place-save')?.disabled).toBe(true);
    act(() => {
      ctx.session.getState().dragHandle('end', [50, -30], 0);
      ctx.session.getState().endDrag();
    });
    expect(byTest('walk-place-save')?.disabled).toBe(false);
  });

  it('Save stays off on Start even when the session is marked changed', async () => {
    const ctx = await open(walkWithPath());
    act(() => {
      ctx.session.setState({ dirty: true });
    });
    expect(strip()?.getAttribute('data-step')).toBe('start');
    expect(byTest('walk-place-save')?.disabled).toBe(true);
  });
});

describe('PlaceWalkStrip: fine-tune', () => {
  it('Fine-tune is offered once placed and shows the pin tools', async () => {
    const ctx = await open(walkWithPath());
    expect(byTest('walk-place-finetune')?.disabled).toBe(true);
    expect(byTest('walk-place-pin-here')).toBeNull();
    twoPins(ctx);
    expect(byTest('walk-place-finetune')?.getAttribute('aria-pressed')).toBe('false');
    click(byTest('walk-place-finetune'));
    expect(byTest('walk-place-pin-here')).not.toBeNull();
    expect(byTest('walk-place-finetune')?.getAttribute('aria-pressed')).toBe('true');
    expect(strip()?.getAttribute('data-step')).toBe('fine-tune');
    expect(hint()).toBe('Scrub to a moment, then Pin here and click the true spot.');
    expect(ctx.openSurface).toHaveBeenLastCalledWith('walk-a', { kind: '3d' }, true);
    click(byTest('walk-place-finetune'));
    expect(strip()?.getAttribute('data-step')).toBe('placed');
    expect(byTest('walk-place-pin-here')).toBeNull();
  });

  it('Pin here and Align view say what to click', async () => {
    const ctx = await open(walkWithPath());
    twoPins(ctx);
    click(byTest('walk-place-finetune'));
    act(() => {
      ctx.session.getState().setTime(20);
    });
    click(byTest('walk-place-pin-here'));
    expect(ctx.session.getState().armed).toBe('pin');
    expect(byTest('walk-place-pin-here')?.getAttribute('aria-pressed')).toBe('true');
    expect(hint()).toBe('Click the true spot for this moment.');
    click(byTest('walk-place-align'));
    expect(hint()).toBe('Click a landmark in the 360 view');
    act(() => {
      ctx.session.getState().align360(0.3);
    });
    expect(hint()).toBe('Now click the same landmark here');
  });

  it('the start and end chips cannot be removed while only two pins exist', async () => {
    const ctx = await open(walkWithPath());
    twoPins(ctx);
    click(byTest('walk-place-finetune'));
    const removes = () => host.querySelectorAll('[aria-label^="Remove pin"]');
    expect(host.querySelectorAll('[data-testid="walk-place-pin"]')).toHaveLength(2);
    expect(removes()).toHaveLength(0);
    act(() => {
      ctx.session.getState().setTime(20);
      ctx.session.getState().pinHere();
    });
    act(() => {
      ctx.session.getState().click([30, 0], 0);
    });
    expect(host.querySelectorAll('[data-testid="walk-place-pin"]')).toHaveLength(3);
    expect(removes()).toHaveLength(3);
  });

  it('a pin chip arms moving that pin: the next click moves it, the other stays', async () => {
    const ctx = await open(walkWithPath());
    twoPins(ctx);
    click(byTest('walk-place-finetune'));
    const move = host.querySelectorAll<HTMLButtonElement>('[data-testid="walk-place-pin-move"]');
    expect(move).toHaveLength(2);
    expect(move[1]?.title).toMatch(/click to move/i);
    expect(move[1]?.getAttribute('aria-label')).toMatch(/^Pin 2: \S.*\. Click to move$/);
    // Esc lets go of an armed move
    click(move[0] ?? null);
    expect(ctx.session.getState().armed).toBe('move');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(ctx.session.getState().armed).toBeNull();
    act(() => {
      ctx.ui.setState({ saving: true });
    });
    expect(move[1]?.disabled).toBe(true);
    act(() => {
      ctx.ui.setState({ saving: false });
    });
    const start = ctx.session.getState().pins[0];
    click(move[1] ?? null);
    expect(ctx.session.getState()).toMatchObject({ armed: 'move', moving: 1 });
    expect(hint()).toBe('Click the new spot for pin 2.');
    act(() => {
      ctx.session.getState().click([70, 20], 0);
    });
    expect(ctx.session.getState().pins[1]?.at).toEqual([70, 20]);
    expect(ctx.session.getState().pins[0]).toEqual(start);
    expect(ctx.session.getState().armed).toBeNull();
  });

  it('the yaw field steps 1 with arrows and 10 with Shift', async () => {
    const ctx = await open(walkWithPath());
    twoPins(ctx);
    click(byTest('walk-place-finetune'));
    const yaw = field('walk-place-yaw');
    if (!yaw) throw new Error('no yaw field');
    const key = (k: string, shiftKey = false) => {
      act(() => {
        yaw.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
      });
    };
    key('ArrowUp');
    expect(ctx.session.getState().yawOffsetDeg).toBe(1);
    key('ArrowUp', true);
    expect(ctx.session.getState().yawOffsetDeg).toBe(11);
    key('ArrowDown');
    expect(ctx.session.getState().yawOffsetDeg).toBe(10);
    key('ArrowDown', true);
    expect(ctx.session.getState().yawOffsetDeg).toBe(0);
    expect(yaw.value).toBe('0');
  });
});

describe('PlaceWalkStrip: map notes', () => {
  it('placing on the map with no imagery says where to turn it on', async () => {
    await open(walkWithPath());
    act(() => {
      placeImagery.setState({ imagery: false });
    });
    choose('map');
    expect(byTest('walk-place-no-imagery')?.textContent).toMatch(/Online satellite.*map type/);
    act(() => {
      placeImagery.setState({ imagery: true });
    });
    expect(byTest('walk-place-no-imagery')).toBeNull();
    act(() => {
      placeImagery.setState({ imagery: false });
    });
    choose('sheet-own');
    expect(byTest('walk-place-no-imagery')).toBeNull();
    act(() => {
      placeImagery.setState({ imagery: null });
    });
  });

  it('a switched off orthomosaic is offered back while placing on the map', async () => {
    const ortho = {
      kind: 'raster' as const,
      id: 'ortho-1',
      name: 'Orthomosaic',
      visible: true,
      src: { path: 'rasters/ortho.tif' },
      role: 'ortho' as const,
      format: 'cog' as const,
    };
    act(() => {
      workspace.setState({ hidden: { 'ortho-1': true } });
    });
    const ctx = setup(walkWithPath());
    project = {
      ...project,
      manifest: { ...project.manifest, layers: [...project.manifest.layers, ortho] },
    };
    await act(async () => {
      await ctx.flow.begin('walk-a');
    });
    act(() => {
      root.render(<PlaceWalkStrip flow={ctx.flow} session={ctx.session} ui={ctx.ui} />);
    });
    act(() => {
      placeImagery.setState({ imagery: false });
    });
    choose('map');
    expect(byTest('walk-place-no-imagery')).toBeNull();
    expect(byTest('walk-place-ortho-off')?.textContent).toContain('orthomosaic is switched off');
    click(byTest('walk-place-ortho-show'));
    expect(workspace.getState().hidden['ortho-1']).toBeUndefined();
    expect(byTest('walk-place-ortho-off')).toBeNull();
    act(() => {
      placeImagery.setState({ imagery: null });
    });
  });
});

describe('PlaceWalkStrip: save, cancel, remove', () => {
  it('Save sends the walk patch and closes; the badge updates from the answered manifest', async () => {
    const ctx = await open(walkWithoutPath());
    const before = project.manifest.layers.find((l) => l.id === 'walk-a') as WalkLayer;
    expect(walkBadge(before, false)?.text).toBe('Needs placing');
    click(byTest('walk-place-anyway'));
    twoPins(ctx);
    await act(async () => {
      byTest('walk-place-save')?.click();
      await Promise.resolve();
    });
    expect(ctx.deps.save).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({
        walk: expect.objectContaining({
          placedOn: '@model',
          pins: [
            expect.objectContaining({ surface: '@model', at: [0, 0] }),
            expect.objectContaining({ surface: '@model', at: [40, -30] }),
          ],
        }) as unknown,
      }),
    );
    expect(ctx.ui.getState().layerId).toBeNull();
    expect(strip()).toBeNull();
    const after = project.manifest.layers.find((l) => l.id === 'walk-a') as WalkLayer;
    expect(walkBadge(after, false)?.text).toBe('Path not computed');
  });

  it('a passing note does not stop Save', async () => {
    const ctx = await open(walkWithPath());
    twoPins(ctx);
    act(() => {
      ctx.session.setState({ error: 'That drawing is not ready' });
    });
    expect(byTest('walk-place-save')?.disabled).toBe(false);
  });

  it('a refused save keeps the strip and says why', async () => {
    const ctx = await open(walkWithPath(), {
      save: vi.fn(() => Promise.resolve('The project folder is read only')),
    });
    twoPins(ctx);
    await act(async () => {
      byTest('walk-place-save')?.click();
      await Promise.resolve();
    });
    expect(strip()).not.toBeNull();
    expect(hint()).toBe('The project folder is read only');
  });

  it('Cancel with changes asks "Keep these changes?"', async () => {
    const ctx = await open(walkWithPath());
    act(() => {
      ctx.session.getState().click([0, 0], 0);
    });
    click(byTest('walk-place-cancel'));
    expect(strip()?.textContent).toContain('Keep these changes?');
    noDialog();
    click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep placing') ?? null,
    );
    expect(hint()).toBe('Click where the walk ended. Esc moves the start.');
    click(byTest('walk-place-cancel'));
    click(byTest('walk-place-discard'));
    expect(ctx.session.getState().layerId).toBeNull();
    expect(ctx.deps.save).not.toHaveBeenCalled();
    expect(strip()).toBeNull();
  });

  it('Cancel without changes closes at once', async () => {
    const ctx = await open(walkWithPath());
    click(byTest('walk-place-cancel'));
    expect(strip()).toBeNull();
    expect(ctx.ui.getState().layerId).toBeNull();
  });

  it('Remove placement shows only for a saved placement and asks inline', async () => {
    await open(walkWithPath());
    expect(byTest('walk-place-remove')).toBeNull();
    const save = vi.fn(() => Promise.resolve(null));
    const ctx = await open(placedWalk(), { save });
    expect(strip()?.getAttribute('data-step')).toBe('placed');
    click(byTest('walk-place-remove'));
    expect(strip()?.textContent).toContain('Remove this placement? The walk stays in the project.');
    noDialog();
    click(byTest('walk-place-remove-yes'));
    await flush();
    expect(save).toHaveBeenCalledWith('walk-a', { walk: null });
    expect(ctx.ui.getState().layerId).toBeNull();
  });

  it('Remove placement is not offered for an unplaced calibration', async () => {
    await open(
      placedWalk({
        place: {
          pins: [{ t: 0, surface: '@model', at: [0, 0] }],
          yawOffsetDeg: 0,
          heightM: 1.7,
          quality: 'unplaced',
        },
      }),
    );
    expect(byTest('walk-place-remove')).toBeNull();
  });

  it('the Remove question takes the focus, and Esc gives it back', async () => {
    await open(placedWalk());
    const remove = byTest('walk-place-remove');
    click(remove);
    const keep = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep it');
    expect(document.activeElement).toBe(keep);
    const controls = remove?.getAttribute('aria-controls');
    expect(controls ? document.getElementById(controls)?.textContent : null).toContain(
      'Remove this placement?',
    );
    act(() => {
      keep?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(byTest('walk-place-remove-yes')).toBeNull();
    expect(document.activeElement).toBe(byTest('walk-place-remove'));
    expect(remove?.getAttribute('aria-expanded')).toBe('false');
  });

  it('Keep it closes the question; a refused remove says why', async () => {
    await open(placedWalk(), {
      save: vi.fn(() => Promise.resolve('The project folder is read only')),
    });
    click(byTest('walk-place-remove'));
    click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep it') ?? null);
    expect(byTest('walk-place-remove-yes')).toBeNull();
    click(byTest('walk-place-remove'));
    click(byTest('walk-place-remove-yes'));
    await flush();
    expect(strip()).not.toBeNull();
    expect(hint()).toBe('The project folder is read only');
  });

  it('no modal element is rendered at any step', async () => {
    const ctx = await open(walkWithoutPath({ capture: undefined }));
    noDialog();
    click(byTest('walk-place-anyway'));
    noDialog();
    twoPins(ctx);
    noDialog();
    click(byTest('walk-place-finetune'));
    click(byTest('walk-place-align'));
    noDialog();
    click(byTest('walk-place-cancel'));
    noDialog();
    expect(strip()).not.toBeNull();
  });
});

describe('where the strip shows', () => {
  it('the 360 pane shows it when no surface pane does', async () => {
    const { stripInWalkPane, stripHosts, PlaceWalkHere } = await import('./PlaceWalkStrip');
    const { placeUi } = await import('./placeWalk');
    expect(stripInWalkPane(null, 1)).toBe(true);
    expect(stripInWalkPane({ kind: 'map' }, 0)).toBe(true);
    expect(stripInWalkPane({ kind: 'map' }, 1)).toBe(false);
    act(() => {
      placeUi.setState({ layerId: 'walk-a', host: { kind: 'map' } });
    });
    act(() => {
      root.render(<PlaceWalkHere at={{ kind: 'map' }} />);
    });
    expect(stripHosts.getState().shown).toBe(1);
    act(() => {
      root.render(<PlaceWalkHere at={{ kind: 'drawing', id: 'x', name: 'X', dated: false }} />);
    });
    expect(stripHosts.getState().shown).toBe(0);
    act(() => {
      placeUi.setState({ layerId: null, host: null });
    });
  });
});
