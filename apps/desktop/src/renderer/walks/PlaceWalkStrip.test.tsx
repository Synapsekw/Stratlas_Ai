// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectManifest, WalkRawPath, type WalkLayer } from '@aio/schema';
import type { OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  shell: { getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn() }) },
  jobs: { getState: () => ({ jobs: [], start: vi.fn() }), subscribe: () => () => undefined },
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));

import { workspace } from '@aio/workspace';
import { placeImagery } from './placeBasemap';
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

function setup(
  walk: WalkLayer,
  opts: { inputs?: WalkInputs; capturedAt?: string; crs?: boolean } = {},
) {
  project = projectWith(walk, opts.crs ?? true);
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
  const deps = {
    project: () => project,
    drawings: () => ({ provisional: false, size: { width: 1000, height: 500 } }),
    loadInputs: vi.fn(() => Promise.resolve(opts.inputs ?? { raw: null, orientation: null })),
    openSurface: vi.fn(),
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
    capturedAt: () => opts.capturedAt,
  } satisfies PlaceWalkDeps;
  const flow = createPlaceWalk(deps, session, ui);
  return { deps, flow, session, ui };
}

type Ctx = ReturnType<typeof setup>;

async function open(ctx: Ctx) {
  await act(async () => {
    await ctx.flow.begin('walk-a');
  });
  act(() => {
    root.render(<PlaceWalkStrip flow={ctx.flow} session={ctx.session} ui={ctx.ui} />);
  });
}

const strip = () => host.querySelector('[data-testid="walk-place-strip"]');
const byTest = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const field = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const say = () => host.querySelector('.dplace-say')?.textContent;
const click = (el: Element | null) => {
  act(() => {
    (el as HTMLElement | null)?.click();
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
/** Start and end pins on the drawing, 50 m apart. */
const twoPins = (ctx: Ctx) => {
  act(() => {
    ctx.session.getState().click([100, 100]);
  });
  act(() => {
    ctx.session.getState().click([600, 100]);
  });
};
const noDialog = () => {
  expect(host.querySelector('[role="dialog"], dialog, [aria-modal]')).toBeNull();
};

beforeEach(() => {
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

describe('PlaceWalkStrip', () => {
  it('shows the date step with the capturedAt date first and Add survey date when missing', async () => {
    const ctx = setup(walkLayer(), { capturedAt: '2026-02-01T10:00:00' });
    await open(ctx);
    expect(say()).toBe('Choose the survey date of this walk');
    const dates = [...host.querySelectorAll('[data-testid="walk-place-date"]')];
    expect(dates.map((d) => d.textContent)).toEqual(['1 Feb 2026, Second', '1 Jan 2026, First']);
    expect(byTest('walk-place-add-date')).toBeNull();
    act(() => {
      root.unmount();
    });
    root = createRoot(host);

    const missing = setup(walkLayer(), { capturedAt: '2026-03-05T08:30:00' });
    await open(missing);
    const add = byTest('walk-place-add-date');
    expect(add?.textContent).toBe('Add survey date 5 Mar 2026');
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    expect(missing.deps.ensureCapture).toHaveBeenCalledWith('2026-03-05');
    expect(missing.deps.setCapture).toHaveBeenCalledWith('walk-a', 'capture-2026-03-05');
    // on to the surface it opened on (the first offered), at its first step
    expect(missing.session.getState().surface).toMatchObject({ id: 'sheet-loose' });
    expect(missing.session.getState().step).toBe('start');
  });

  it('Place on lists drawings and Map; choosing one opens it in the surface pane', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    const options = [...host.querySelectorAll('[data-testid="walk-place-on"] option')]
      .filter((o) => !(o as HTMLOptionElement).disabled)
      .map((o) => o.textContent);
    expect(options).toEqual(['Ground floor', 'Site plan', 'Map', '3D view']);
    ctx.deps.openSurface.mockClear();
    choose('sheet-loose');
    expect(ctx.deps.openSurface).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({ kind: 'drawing', id: 'sheet-loose' }),
    );
    expect(ctx.ui.getState().host).toMatchObject({ kind: 'drawing', id: 'sheet-loose' });
    choose('map');
    expect(ctx.deps.openSurface).toHaveBeenLastCalledWith('walk-a', { kind: 'map' });
    choose('3d');
    expect(ctx.deps.openSurface).toHaveBeenLastCalledWith('walk-a', { kind: '3d' });
    expect(ctx.ui.getState().host).toEqual({ kind: '3d' });
    const values = [...host.querySelectorAll('[data-testid="walk-place-on"] option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('offers no Map without a coordinate system', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }), { crs: false });
    await open(ctx);
    const options = [...host.querySelectorAll('[data-testid="walk-place-on"] option')].map(
      (o) => o.textContent,
    );
    expect(options).not.toContain('Map');
  });

  it('step text: Where did the walk start? Click the spot.', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    expect(say()).toBe('Where did the walk start? Click the spot.');
    act(() => {
      ctx.session.getState().click([100, 100]);
    });
    expect(say()).toBe('Where did it end? Click the spot.');
    act(() => {
      ctx.session.getState().click([600, 100]);
    });
    expect(say()).toBe('Scrub to a moment, then Pin here and click the true spot.');
    click(byTest('walk-place-align'));
    expect(say()).toBe('Click a landmark in the 360 view');
    act(() => {
      ctx.session.getState().align360(0.3);
    });
    expect(say()).toBe('Now click the same landmark here');
  });

  it('only the current step button is primary', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    const primaries = () =>
      [...host.querySelectorAll('.primary')].map((b) => b.getAttribute('data-testid'));
    expect(primaries()).toEqual(['walk-place-step-start']);
    expect(byTest('walk-place-step-start')?.getAttribute('aria-current')).toBe('step');
    // the step in hand is a marker, not a button that does nothing
    expect(byTest('walk-place-step-start')?.tagName).toBe('SPAN');
    expect(byTest('walk-place-step-end')?.disabled).toBe(true);
    twoPins(ctx);
    expect(primaries()).toEqual(['walk-place-step-correct']);
    // a step already done shows its moment again
    click(byTest('walk-place-step-start'));
    expect(ctx.ui.getState().seek?.t).toBe(ctx.session.getState().pins[0]?.t);
  });

  it('Pin here is disabled until two pins exist', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    expect(byTest('walk-place-pin-here')?.disabled).toBe(true);
    act(() => {
      ctx.session.getState().click([100, 100]);
    });
    expect(byTest('walk-place-pin-here')?.disabled).toBe(true);
    act(() => {
      ctx.session.getState().click([600, 100]);
    });
    expect(byTest('walk-place-pin-here')?.disabled).toBe(false);
    expect(host.querySelectorAll('[data-testid="walk-place-pin"]')).toHaveLength(2);
    act(() => {
      ctx.session.getState().setTime(20);
    });
    click(byTest('walk-place-pin-here'));
    expect(ctx.session.getState().armed).toBe('pin');
    expect(byTest('walk-place-pin-here')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a pin chip arms moving that pin: the next click moves it, the other stays', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    twoPins(ctx);
    const move = host.querySelectorAll<HTMLButtonElement>('[data-testid="walk-place-pin-move"]');
    expect(move).toHaveLength(2);
    expect(move[1]?.title).toMatch(/click to move/i);
    // its name reads as words, not "2set"
    expect(move[1]?.getAttribute('aria-label')).toMatch(/^Pin 2: \S.*\. Click to move$/);
    // Esc lets go of an armed move
    click(move[0] ?? null);
    expect(ctx.session.getState().armed).toBe('move');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(ctx.session.getState().armed).toBeNull();
    // not while saving
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
    expect(move[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(byTest('walk-place-strip')?.textContent).toContain('Click the new spot for pin 2.');
    act(() => {
      ctx.session.getState().click([700, 200]);
    });
    expect(ctx.session.getState().pins[1]?.at).toEqual([700, 200]);
    expect(ctx.session.getState().pins[0]).toEqual(start);
    expect(ctx.session.getState().armed).toBeNull();
  });

  it('placing on the map with no imagery says where to turn it on', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    act(() => {
      placeImagery.setState({ imagery: false });
    });
    choose('map');
    expect(byTest('walk-place-no-imagery')?.textContent).toMatch(/Online satellite.*map type/);
    act(() => {
      placeImagery.setState({ imagery: true });
    });
    expect(byTest('walk-place-no-imagery')).toBeNull();
    // on a drawing the map's imagery does not matter
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
    const ctx = setup(walkLayer({ capture: 'c1' }));
    const ortho = {
      kind: 'raster' as const,
      id: 'ortho-1',
      name: 'Orthomosaic',
      visible: true,
      src: { path: 'rasters/ortho.tif' },
      role: 'ortho' as const,
      format: 'cog' as const,
    };
    project = {
      ...project,
      manifest: { ...project.manifest, layers: [...project.manifest.layers, ortho] },
    };
    act(() => {
      workspace.setState({ hidden: { 'ortho-1': true } });
    });
    await open(ctx);
    act(() => {
      placeImagery.setState({ imagery: false });
    });
    choose('map');
    // the project's own imagery is there, only switched off: that is what the strip says
    expect(byTest('walk-place-no-imagery')).toBeNull();
    const note = byTest('walk-place-ortho-off');
    expect(note?.textContent).toContain('orthomosaic is switched off');
    click(byTest('walk-place-ortho-show'));
    expect(workspace.getState().hidden['ortho-1']).toBeUndefined();
    expect(byTest('walk-place-ortho-off')).toBeNull();
    act(() => {
      placeImagery.setState({ imagery: null });
    });
  });

  it('the yaw field steps 1 with arrows and 10 with Shift', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    twoPins(ctx);
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

  it('Save sends the walk patch and closes; the badge updates from the answered manifest', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    const before = project.manifest.layers.find((l) => l.id === 'walk-a') as WalkLayer;
    expect(walkBadge(before, false)?.text).toBe('Needs placing');
    choose('sheet-own');
    expect(byTest('walk-place-save')?.disabled).toBe(true);
    twoPins(ctx);
    await act(async () => {
      byTest('walk-place-save')?.click();
      await Promise.resolve();
    });
    expect(ctx.deps.save).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({
        walk: expect.objectContaining({
          placedOn: 'sheet-own',
          pins: [
            expect.objectContaining({ surface: 'sheet-own', at: [100, 100] }),
            expect.objectContaining({ surface: 'sheet-own', at: [600, 100] }),
          ],
        }) as unknown,
      }),
    );
    expect(ctx.ui.getState().layerId).toBeNull();
    expect(ctx.session.getState().layerId).toBeNull();
    expect(strip()).toBeNull();
    const after = project.manifest.layers.find((l) => l.id === 'walk-a') as WalkLayer;
    // placed between the pins only: no longer Needs placing
    expect(walkBadge(after, false)?.text).toBe('Path not computed');
  });

  it('a passing note does not stop Save; the fit refusing does', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    twoPins(ctx);
    act(() => {
      ctx.session.setState({ error: 'That drawing is not ready' });
    });
    expect(byTest('walk-place-save')?.disabled).toBe(false);
  });

  it('a refused save keeps the strip and says why', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    ctx.deps.save.mockImplementationOnce(() => Promise.resolve('The project folder is read only'));
    await open(ctx);
    choose('sheet-own');
    twoPins(ctx);
    await act(async () => {
      byTest('walk-place-save')?.click();
      await Promise.resolve();
    });
    expect(strip()).not.toBeNull();
    expect(host.querySelector('.dplace-say.bad')?.textContent).toBe(
      'The project folder is read only',
    );
  });

  it('closing with unsaved pins asks inline: Keep these pins?', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    choose('sheet-own');
    twoPins(ctx);
    click(byTest('walk-place-cancel'));
    expect(say()).toBe('Keep these pins?');
    noDialog();
    expect(ctx.session.getState().layerId).toBe('walk-a');
    click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep placing') ?? null,
    );
    expect(say()).toBe('Scrub to a moment, then Pin here and click the true spot.');
    click(byTest('walk-place-cancel'));
    click(byTest('walk-place-discard'));
    expect(ctx.session.getState().layerId).toBeNull();
    expect(ctx.deps.save).not.toHaveBeenCalled();
    expect(strip()).toBeNull();
  });

  it('Cancel without changes closes at once', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    click(byTest('walk-place-cancel'));
    expect(strip()).toBeNull();
    expect(ctx.ui.getState().layerId).toBeNull();
  });

  it('pins-only note when the walk has no path', async () => {
    const ctx = setup(walkLayer({ capture: 'c1' }));
    await open(ctx);
    expect(byTest('walk-place-pins-only')?.textContent).toBe(
      'Path not computed: the walk is placed between your pins.',
    );
    act(() => {
      root.unmount();
    });
    root = createRoot(host);
    const withPath = setup(walkLayer({ capture: 'c1' }), { inputs: { raw, orientation: null } });
    await open(withPath);
    expect(byTest('walk-place-pins-only')).toBeNull();
  });

  it('no modal element is rendered at any step', async () => {
    const ctx = setup(walkLayer(), { capturedAt: '2026-03-05T08:30:00' });
    await open(ctx);
    noDialog();
    await act(async () => {
      byTest('walk-place-add-date')?.click();
      await Promise.resolve();
    });
    noDialog();
    choose('sheet-loose');
    noDialog();
    twoPins(ctx);
    noDialog();
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
