// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
/**
 * The antenna inventory in the real Project tab (the Measure workbench), with the runner the stage
 * mounts beside it: its Antennas group in the "In this project" list, its CSV tool next to Export
 * survey data, a tools search, the live strip, a 3D pick, and the AI send preview, a dialog under
 * <body> that a run opens whatever is on screen. The group's reveal hold is AntennasGroup.test's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as EngineModule from '@aio/engine';
import { AntennasFile, type JobRecord } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ShellModule from '../shell';
import type * as StageToolsModule from '../workspace/StageTools';
import { jobs, shell } from '../shell';
import { measureStore, startTool, stopTool } from '../survey/measureStore';
import { MeasureBench } from '../workspace/workbench/benches/MeasureBench';
import { AntennaRunner } from './AntennaRunner';
import { sectionStore } from '../workspace/workbench/sectionState';
import {
  antennaStore,
  filteredUnits,
  loadAntennas,
  openAntennaReview,
  runDetection,
  setAiLabelPref,
} from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(
  (): {
    disk: unknown;
    calls: [string, Record<string, unknown>][];
    replies: Record<string, unknown>;
    layerPick: null | ((id: string) => void);
  } => ({ disk: null, calls: [], replies: {}, layerPick: null }),
);

vi.mock('../shell', async (importOriginal) => {
  const real = await importOriginal<typeof ShellModule>();
  return {
    ...real,
    bridge: {
      ...real.bridge,
      call: vi.fn((channel: string, req: Record<string, unknown>) => {
        h.calls.push([channel, req]);
        if (channel === 'telecom:readAntennas')
          return Promise.resolve({
            ok: true,
            value: { ok: true, file: structuredClone(h.disk), readOnly: false },
          });
        if (channel === 'telecom:writeAntennas')
          return Promise.resolve({ ok: true, value: { ok: true } });
        if (channel === 'jobs:start')
          return Promise.resolve({
            ok: true,
            value: { ok: true, job: { id: 'j1', status: 'starting' } },
          });
        return Promise.resolve(h.replies[channel] ?? { ok: false, error: 'unexpected' });
      }),
    },
  };
});
vi.mock('@aio/engine', async (importOriginal) => {
  const stage = {
    layerLoaded: () => true,
    onLayerLoaded: () => () => undefined,
  };
  return {
    ...(await importOriginal<typeof EngineModule>()),
    getActiveStage: () => stage,
    onActiveScene: () => () => undefined,
  };
});
// the bench's own tools see no 3D view (they are tested with the bench); the inventory's runner
// and button do (`getActiveStage` above)
vi.mock('../workspace/StageTools', async (importOriginal) => ({
  ...(await importOriginal<typeof StageToolsModule>()),
  useEngineStage: () => null,
}));
vi.mock('./antennaScene', () => ({
  KIND_COLOURS: { panel: '#111', short: '#222', dish: '#333', other: '#444' },
  attachAntennaLayer: (_stage: unknown, _frame: unknown, opts: { onPick(id: string): void }) => {
    h.layerPick = (id) => {
      opts.onPick(id);
    };
    return () => {
      h.layerPick = null;
    };
  },
  armTowerPick: () => () => undefined,
  antennaShift: () => null,
  antennaLabelSpots: () => [],
  labelSpotsCache: () => () => [],
}));
// the labels and the camera framing are the runner's own tests
vi.mock('./antennaLabels', () => ({ attachAntennaLabels: () => () => undefined }));
vi.mock('../workspace/flyToBox', () => ({ flyToLocalBox: () => undefined }));
vi.mock('../builder/photoOpen', () => ({ openPhoto: () => undefined }));
// the site data tools are their own screens: here only that the bench lists them
vi.mock('../survey/ExportDialog', () => ({
  ExportTool: () => (
    <button type="button" data-testid="survey-export-open">
      Export survey data
    </button>
  ),
  ExportDialogMount: () => null,
}));
vi.mock('../survey/Designs', () => ({ DesignsTool: () => null }));
vi.mock('../survey/HaulRoad', () => ({ HaulRoadTool: () => null }));
vi.mock('../survey/MagicPolygon', () => ({ MagicPolygon: () => null }));
vi.mock('../survey/BulkTotals', () => ({ BulkTotals: () => null }));

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };
const sample = (runId = 'run-a'): AntennasFile => {
  const f = AntennasFile.parse(structuredClone(contract.example));
  return { ...f, run: { ...f.run, id: runId } };
};

const PREVIEW = {
  ok: true,
  value: {
    ok: true,
    provider: 'anthropic',
    model: 'm1',
    cloud: true,
    photosAllowed: true,
    crops: [{ unitId: 'ant-o1', path: 'telecom/crops/ant-o1.jpg' }],
    missing: [],
    estimate: { images: 1, inputTokens: 900, costUsd: 0.02 },
    token: 'tok-1',
  },
};

let host: HTMLElement;
let root: Root | undefined;
let runnerHost: HTMLElement;
let runnerRoot: Root | undefined;
let restore: (() => void)[] = [];
let scrollSpy = vi.fn();

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
/**
 * The bench as the sidebar shows it, or inside a folded, inert sidebar (the drawer case), or not
 * at all (another tab in front); the runner is the stage's, outside the sidebar, always there.
 */
async function mount(where: 'sidebar' | 'inert' | 'none' = 'sidebar') {
  host.toggleAttribute('inert', where === 'inert');
  root ??= createRoot(host);
  runnerRoot ??= createRoot(runnerHost);
  act(() => {
    root?.render(where === 'none' ? null : <MeasureBench />);
    runnerRoot?.render(<AntennaRunner />);
  });
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const section = () => q('[data-testid="wb-section-project-antennas"]');
const head = () => section()?.querySelector<HTMLButtonElement>('.wb-section-head') ?? null;
const channels = (name: string) => h.calls.filter(([c]) => c === name);
const search = (value: string) => {
  const input = q('input[type="search"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
/** The detection job ends well: the jobs store reports it done. */
async function finishJob() {
  act(() => {
    jobs.setState({ jobs: [{ id: 'j1', status: 'done' } as unknown as JobRecord] });
  });
  await flush();
}

beforeEach(() => {
  host = document.createElement('div');
  runnerHost = document.createElement('div');
  document.body.append(host, runnerHost);
  h.disk = sample();
  h.calls = [];
  h.replies = {};
  h.layerPick = null;
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  shell.setState({ pkg: null, stageMode: '3d' });
  jobs.setState({ jobs: [] });
  workspace.setState({
    project: {
      id: 'p1',
      root: 'C:/proj',
      manifest: {
        purpose: 'telecom',
        crs: { kind: 'local' },
        origin: [0, 0, 0],
        captures: [],
        layers: [{ kind: 'pointcloud', id: 'cloud-1', name: 'Cloud', visible: true }],
      },
    },
  } as unknown as Parameters<typeof workspace.setState>[0]);
  measureStore.setState({ projectId: 'p1', status: 'ready', tool: null, draw: null, focus: null });
  antennaStore.setState(antennaStore.getInitialState());
  scrollSpy = vi.fn();
  const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  HTMLElement.prototype.scrollIntoView = scrollSpy;
  const ro = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
  restore = [
    () => {
      if (before) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', before);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    },
    () => {
      globalThis.ResizeObserver = ro;
    },
  ];
});
afterEach(() => {
  act(() => {
    root?.unmount();
    runnerRoot?.unmount();
  });
  root = undefined;
  runnerRoot = undefined;
  host.remove();
  runnerHost.remove();
  stopTool();
  for (const r of restore) r();
  vi.useRealTimers();
});

describe('the antenna inventory in the Measure workbench', () => {
  it('is the Antennas group of the list, with its CSV tool next to Export survey data', async () => {
    await mount();
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(head()?.textContent).toContain('Antennas');
    // in the "In this project" list, above the TOOLS caption
    const list = q('[data-testid="project-list"]')!;
    expect(list.contains(section())).toBe(true);
    const tools = q('[data-testid="project-tools-caption"]')!;
    expect(
      section()!.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // the review filter starts on the drafts; the All tab lists every unit
    expect(section()?.querySelectorAll('[data-testid="antenna-row"]')).toHaveLength(2);
    expect(q('[data-testid="antenna-filter-all"]')?.textContent).toBe('All 3');
    await act(async () => {
      q('[data-testid="antenna-filter-all"]')!.click();
      await Promise.resolve();
    });
    expect(section()?.querySelectorAll('[data-testid="antenna-row"]')).toHaveLength(3);
    const exp = q('[data-testid="survey-export-open"]')!;
    const csv = q('[aria-label="Export antenna inventory (CSV)"]')!;
    expect(csv).not.toBeNull();
    // in the same tool row, right after it
    expect(exp.closest('.tgroup-h')).toBe(csv.closest('.tgroup-h'));
    expect(csv.querySelector('svg')?.innerHTML).not.toBe(exp.querySelector('svg')?.innerHTML);
    // one Detect antennas button, in the Telecom family
    expect(host.querySelectorAll('[data-testid="detect-antennas"]')).toHaveLength(1);
  });

  it('with no inventory yet, shows Flag antenna disabled with its reason', async () => {
    h.disk = null;
    await mount();
    expect(section()).not.toBeNull();
    const flag = q('[data-testid="antenna-flag"]')!;
    expect(flag.getAttribute('aria-disabled')).toBe('true');
    const id = flag.getAttribute('aria-describedby') ?? '';
    expect(host.querySelector(`[id="${id}"]`)?.textContent).toBe('Run antenna detection first');
  });

  it('exports the CSV through the save dialog', async () => {
    h.replies['dialog:saveFile'] = { ok: true, value: { path: 'C:/out/antenna-inventory.csv' } };
    await mount();
    act(() => {
      q('[aria-label="Export antenna inventory (CSV)"]')!.click();
    });
    act(() => {
      q('[data-testid="antenna-csv"]')!.click();
    });
    await flush();
    const save = channels('dialog:saveFile');
    expect(save).toHaveLength(1);
    expect(save[0]![1]).toMatchObject({ defaultName: 'antenna-inventory.csv' });
    expect(host.textContent).toContain('Exported to C:/out/antenna-inventory.csv.');
  });

  it('stays as it is while the tools are searched (a search filters only the tools)', async () => {
    await mount();
    search('zzz');
    expect(section()).not.toBeNull();
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(section()?.querySelectorAll('[data-testid="antenna-row"]')).toHaveLength(2);
    // a fold the person chose stays through a search
    act(() => {
      head()!.click();
    });
    search('antenna');
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    search('');
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('stays, with one Detect antennas button, while a tool is live and a search was typed', async () => {
    await mount();
    search('zzz');
    act(() => {
      startTool('distance');
    });
    await flush();
    expect(section()).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="detect-antennas"]').length).toBeLessThanOrEqual(1);
    act(() => {
      stopTool();
    });
    act(() => {
      startTool('clearance');
    });
    await flush();
    expect(section()).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="detect-antennas"]')).toHaveLength(1);
  });

  it('a unit picked in 3D opens its details under its row, never scrolling the window', async () => {
    await mount();
    act(() => {
      h.layerPick!('ant-d1');
    });
    expect(antennaStore.getState().selected).toBe('ant-d1');
    const item = section()!.querySelector('[data-row-id="ant-d1"]')!;
    expect(item.contains(q('[data-testid="antenna-details"]'))).toBe(true);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('openAntennaReview (another tool asks for the review)', () => {
  it('selects the first draft under To review, its details under its row', async () => {
    await mount();
    const s = antennaStore.getState();
    const first = filteredUnits(s.file, 'draft')[0]!.id;
    act(() => {
      openAntennaReview();
    });
    expect(antennaStore.getState()).toMatchObject({ filter: 'draft', selected: first });
    expect(q('[data-testid="antenna-filter-draft"]')?.getAttribute('aria-selected')).toBe('true');
    const item = section()!.querySelector(`[data-row-id="${first}"]`)!;
    expect(item.contains(q('[data-testid="antenna-details"]'))).toBe(true);
  });
});

describe('AI labelling after a run', () => {
  async function runAndFinish(where: 'sidebar' | 'inert' | 'none') {
    setAiLabelPref('p1', true);
    await mount(where);
    await act(async () => {
      await runDetection();
    });
    h.disk = sample('run-b');
    await finishJob();
  }

  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

  it('shows the preview as a dialog under <body>, usable from a folded, inert sidebar', async () => {
    h.replies['ai:antennaLabelPreview'] = PREVIEW;
    h.replies['ai:labelAntennas'] = {
      ok: true,
      value: {
        ok: true,
        provider: 'anthropic',
        model: 'm1',
        promptVersion: 'v1',
        labels: [{ unitId: 'ant-o1', label: 'radio-unit', reason: 'boxy' }],
        inputTokens: 900,
        outputTokens: 20,
        costUsd: 0.02,
        warnings: [],
      },
    };
    await runAndFinish('inert');
    const d = dialog();
    expect(d).not.toBeNull();
    expect(host.contains(d)).toBe(false);
    expect(d!.closest('[inert]')).toBeNull();
    expect(d!.closest('.antenna-send-layer')?.parentElement).toBe(document.body);
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    const send = d!.querySelector<HTMLElement>('[data-testid="antenna-send"]')!;
    expect(send.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      send.click();
    });
    await flush();
    expect(channels('ai:labelAntennas')[0]![1]).toMatchObject({ token: 'tok-1', photos: true });
    expect(antennaStore.getState().file!.units.find((u) => u.id === 'ant-o1')?.kindBasis).toBe(
      'ai',
    );
    expect(dialog()).toBeNull();
  });

  it('shows it for a run that ends while another tab is in front', async () => {
    h.replies['ai:antennaLabelPreview'] = PREVIEW;
    await runAndFinish('none');
    expect(section()).toBeNull();
    expect(channels('ai:antennaLabelPreview')).toHaveLength(1);
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.closest('[inert]')).toBeNull();
  });

  it('offers it when a newer read of the inventory overtakes the one after the run', async () => {
    h.replies['ai:antennaLabelPreview'] = PREVIEW;
    setAiLabelPref('p1', true);
    antennaStore.setState({ projectId: 'p1', root: 'C:/proj', file: sample(), status: 'ready' });
    await act(async () => {
      await runDetection();
    });
    h.disk = sample('run-b');
    act(() => {
      jobs.setState({ jobs: [{ id: 'j1', status: 'done' } as unknown as JobRecord] });
      // a bench mounting now reads the inventory again, before the first read is back
      void loadAntennas('p1', 'C:/proj');
    });
    await flush();
    expect(antennaStore.getState().file?.run.id).toBe('run-b');
    expect(channels('ai:antennaLabelPreview')).toHaveLength(1);
    expect(antennaStore.getState().aiPreview).not.toBeNull();
  });

  it('says why it was skipped in the Antennas group, above the rows', async () => {
    h.replies['ai:antennaLabelPreview'] = { ok: true, value: { ok: false, error: 'offline' } };
    await runAndFinish('sidebar');
    const note = q('[data-testid="antenna-ai-note"]')!;
    expect(note.textContent).toBe('AI labelling skipped: offline');
    expect(section()!.contains(note)).toBe(true);
    expect(note.closest('[inert]')).toBeNull();
    expect(dialog()).toBeNull();
  });
});
