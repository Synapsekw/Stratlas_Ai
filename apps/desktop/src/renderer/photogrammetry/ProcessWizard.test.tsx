// @vitest-environment jsdom
import { ProjectManifest, emptyRemovalPlan, type RemovalPlan } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WizardInitial } from './startOver';

const { call, startAlign, removeNow, openProcessingEngine } = vi.hoisted(() => ({
  call: vi.fn(),
  openProcessingEngine: vi.fn(),
  startAlign: vi.fn<(a: { run: string }) => Promise<string | null>>(),
  removeNow: vi.fn<(targets: { run: string }[], shown?: unknown) => Promise<string | null>>(),
}));
vi.mock('../shell', () => ({
  bridge: { call },
  useShell: (selector: (s: { pkg: null }) => unknown) => selector({ pkg: null }),
}));
vi.mock('../shell/removal', () => ({ removal: { getState: () => ({ removeNow }) } }));
vi.mock('../processingTools', () => ({ openProcessingTools: vi.fn() }));
vi.mock('./actions', () => ({ startAlign }));
vi.mock('../odm', () => ({ openProcessingEngine }));

import { ProcessWizard } from './ProcessWizard';
import { photoUi } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GB = 1024 ** 3;
/** The run Start over replaces: the id a run started at the faked time would get. */
const OLD = '20261013-0930';
const manifest = (id: string) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id,
    name: 'Start over site',
    customer: 'Test',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  });
const initial: WizardInitial = {
  source: { folders: ['C:/Flights/A'] },
  preset: 'fast',
  gnss: 'auto',
  products: ['ortho'],
  replaces: OLD,
};
const answer = (value: Record<string, unknown>) => Promise.resolve({ ok: true, value });
/** What goes with the old run, as main plans it: the run and its map layer. */
const RUN_PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  runs: [{ id: OLD, status: 'failed', why: 'asked' }],
  layers: [{ id: 'ortho', name: 'Ortho', kind: 'raster', why: { madeBy: OLD } }],
  files: [`photogrammetry/${OLD}`],
  bytes: 10,
};
let oldPlan: RemovalPlan = RUN_PLAN;
let probeOver: Record<string, unknown> = {};

let host: HTMLDivElement;
let root: Root | undefined;
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await Promise.resolve();
    });
};
const mount = async (start: WizardInitial = initial) => {
  photoUi.getState().openWizard(start);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ProcessWizard />);
    await Promise.resolve();
  });
  await flush();
};
const startButton = () => {
  const b = host.querySelector<HTMLButtonElement>('[data-testid="photo-start"]');
  if (!b) throw new Error('no Create maps button');
  return b;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 13, 9, 30));
  host = document.createElement('div');
  document.body.append(host);
  call.mockReset();
  startAlign.mockReset();
  removeNow.mockReset();
  removeNow.mockResolvedValue(null);
  oldPlan = RUN_PLAN;
  probeOver = {};
  photoUi.setState({ view: null, held: [], notes: {}, pending: {}, dates: {} });
  // main has not listed the old run (its folder unreadable): the wizard still never reuses its id
  call.mockImplementation((channel: string) => {
    if (channel === 'photo:probe')
      return answer({
        ok: true,
        probe: {
          platform: 'win32',
          arch: 'x64',
          cpu: { model: 'Synthetic CPU', cores: 8 },
          memoryBytes: 32 * GB,
          freeDiskBytes: 512 * GB,
          gpus: [],
          cuda: false,
          processing: 'available',
          ...probeOver,
        },
      });
    if (channel === 'photo:estimate')
      return answer({
        ok: true,
        estimate: { minutes: [10, 20], diskBytes: GB, memoryBytes: GB },
      });
    if (channel === 'photo:runs') return answer({ ok: true, runs: [] });
    if (channel === 'builder:removePlan') return answer({ ok: true, plan: oldPlan });
    throw new Error(`unexpected channel ${channel}`);
  });
  workspace.getState().openProject({ id: 'p1', root: '/site', manifest: manifest('p1') });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.useRealTimers();
});

describe('Start over in the process wizard', () => {
  it('opens as Start over and removes nothing when it is closed', async () => {
    await mount();
    expect(host.querySelector('h2')?.textContent).toBe(`Start run ${OLD} over`);
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    act(() => close?.click());
    await flush();
    expect(startAlign).not.toHaveBeenCalled();
    expect(removeNow).not.toHaveBeenCalled();
  });

  it('removes nothing when the start is refused', async () => {
    startAlign.mockResolvedValue('No pipeline pack is installed.');
    await mount();
    act(() => {
      startButton().click();
    });
    await flush();
    expect(startAlign).toHaveBeenCalledTimes(1);
    expect(removeNow).not.toHaveBeenCalled();
    expect(host.textContent).toContain('No pipeline pack is installed.');
  });

  it('starts a new run under another id, then removes the old run once', async () => {
    startAlign.mockResolvedValue(null);
    await mount();
    act(() => {
      startButton().click();
    });
    await flush();
    const run = startAlign.mock.calls[0]?.[0].run;
    expect(run).toBeDefined();
    expect(run).not.toBe(OLD);
    expect(removeNow).toHaveBeenCalledTimes(1);
    expect(removeNow).toHaveBeenCalledWith([{ run: OLD }], RUN_PLAN);
    expect(photoUi.getState().view).toEqual({ kind: 'run', run, tab: 'progress' });
  });

  it('two clicks on Create maps start one run and one removal', async () => {
    let finish: (v: string | null) => void = () => undefined;
    startAlign.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let removed: (v: string | null) => void = () => undefined;
    removeNow.mockImplementation(
      () =>
        new Promise((resolve) => {
          removed = resolve;
        }),
    );
    await mount();
    act(() => {
      startButton().click();
      startButton().click();
    });
    await flush();
    await act(async () => {
      finish(null);
      await Promise.resolve();
    });
    await flush();
    // a click while the old run is being removed starts nothing either
    host.querySelector<HTMLButtonElement>('[data-testid="photo-start"]')?.click();
    await act(async () => {
      removed('A file is held open.');
      await Promise.resolve();
    });
    await flush();
    expect(startAlign).toHaveBeenCalledTimes(1);
    expect(removeNow).toHaveBeenCalledTimes(1);
    const run = startAlign.mock.calls[0]?.[0].run ?? '';
    expect(photoUi.getState().notes[run]).toBe(`Run ${OLD} is still there: A file is held open.`);
  });

  it('closed while starting: the run starts and the old run goes, the run panel does not open', async () => {
    let finish: (v: string | null) => void = () => undefined;
    startAlign.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    act(() => {
      startButton().click();
    });
    await flush();
    act(() => {
      photoUi.getState().close();
    });
    await act(async () => {
      finish(null);
      await Promise.resolve();
    });
    await flush();
    expect(removeNow).toHaveBeenCalledWith([{ run: OLD }], RUN_PLAN);
    expect(photoUi.getState().view).toBeNull();
  });

  it('never removes a run of another project opened meanwhile', async () => {
    let finish: (v: string | null) => void = () => undefined;
    startAlign.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    act(() => {
      startButton().click();
    });
    await flush();
    act(() => {
      workspace.getState().openProject({ id: 'p2', root: '/other', manifest: manifest('p2') });
    });
    await act(async () => {
      finish(null);
      await Promise.resolve();
    });
    await flush();
    expect(removeNow).not.toHaveBeenCalled();
    const run = startAlign.mock.calls[0]?.[0].run ?? '';
    expect(photoUi.getState().notes[run]).toBe(
      `Run ${OLD} is still there: Another project was opened meanwhile.`,
    );
  });
  it('says what goes with the old run, and removes by that plan', async () => {
    oldPlan = {
      ...RUN_PLAN,
      changes: [{ id: 'chg-1', name: '12 Oct to 26 Oct', why: { usedBy: 'ortho' } }],
    };
    startAlign.mockResolvedValue(null);
    await mount();
    const line = host.querySelector('[data-testid="start-over-removes"]')?.textContent;
    expect(line).toBe(
      `Run ${OLD} and what it made go to the project trash when this run starts. Also removes: 1 comparison (12 Oct to 26 Oct).`,
    );
    expect(call).toHaveBeenCalledWith('builder:removePlan', {
      projectId: 'p1',
      targets: [{ run: OLD }],
    });
    act(() => {
      startButton().click();
    });
    await flush();
    expect(removeNow).toHaveBeenCalledWith([{ run: OLD }], oldPlan);
  });

  it('a refused plan: says the old run stays, and never removes it', async () => {
    oldPlan = {
      ...RUN_PLAN,
      refused: `Creating maps for run ${OLD} is still running. Cancel it first.`,
    };
    startAlign.mockResolvedValue(null);
    await mount();
    expect(host.querySelector('[data-testid="start-over-removes"]')?.textContent).toBe(
      `Run ${OLD} stays when this run starts: Creating maps for run ${OLD} is still running. Cancel it first.`,
    );
    act(() => {
      startButton().click();
    });
    await flush();
    expect(startAlign).toHaveBeenCalledTimes(1);
    expect(removeNow).not.toHaveBeenCalled();
    const run = startAlign.mock.calls[0]?.[0].run ?? '';
    expect(photoUi.getState().notes[run]).toBe(
      `Run ${OLD} is still there: Creating maps for run ${OLD} is still running. Cancel it first.`,
    );
  });

  it('a start that throws leaves the wizard ready to try again', async () => {
    startAlign.mockRejectedValueOnce(new Error('The channel to main closed.'));
    startAlign.mockResolvedValueOnce(null);
    await mount();
    act(() => {
      startButton().click();
    });
    await flush();
    expect(host.textContent).toContain('The channel to main closed.');
    expect(startButton().disabled).toBe(false);
    expect(removeNow).not.toHaveBeenCalled();
    act(() => {
      startButton().click();
    });
    await flush();
    expect(startAlign).toHaveBeenCalledTimes(2);
    expect(removeNow).toHaveBeenCalledTimes(1);
  });
});

describe('the wizard with the processing engine and Quick', () => {
  it('blocks with an install button until the engine is installed', async () => {
    probeOver = { processing: 'no-engine' };
    await mount();
    expect(host.querySelector('[data-testid="photo-blocked"]')?.textContent).toContain(
      'Install the processing engine first',
    );
    const fix = host.querySelector<HTMLButtonElement>('[data-testid="photo-fix"]');
    expect(fix?.textContent).toBe('Install the processing engine');
    act(() => fix?.click());
    expect(openProcessingEngine).toHaveBeenCalledTimes(1);
  });

  it('shows 3D mesh and 3D Tiles unchecked and disabled with Quick, with a note', async () => {
    await mount({ ...initial, preset: 'fast', products: ['ortho', 'mesh', 'tiles'] });
    const box = (label: string) =>
      [...host.querySelectorAll<HTMLLabelElement>('.ph-check')]
        .find((l) => l.textContent.includes(label))
        ?.querySelector('input');
    for (const label of ['Textured mesh', '3D Tiles']) {
      expect(box(label)?.checked).toBe(false);
      expect(box(label)?.disabled).toBe(true);
    }
    expect(box('Orthomosaic')?.checked).toBe(true);
    expect(host.textContent).toContain('Quick makes no 3D model.');
  });
});
