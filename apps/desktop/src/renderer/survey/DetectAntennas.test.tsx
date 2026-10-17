// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaSendPreview } from '../telecom/AntennaSendPreview';
import { antennaStore, setAiLabelPref } from '../telecom/antennaStore';
import { CSV_COLUMNS } from '../telecom/antennaCsv';
import { DetectAntennas } from './DetectAntennas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(
  (): {
    disk: unknown;
    calls: [string, Record<string, unknown>][];
    replies: Record<string, unknown>;
    layers: unknown[];
    loaded: boolean;
    pick: null | ((p: [number, number, number]) => void);
    layerPick: null | ((id: string) => void);
  } => ({
    disk: null,
    calls: [],
    replies: {},
    layers: [],
    loaded: true,
    pick: null,
    layerPick: null,
  }),
);

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  const jobs = createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] }));
  return {
    jobs,
    useShell: <T,>(sel: (s: { pkg: null }) => T) => sel({ pkg: null }),
    bridge: {
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

vi.mock('@aio/workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspace: <T,>(sel: (s: unknown) => T) =>
    sel({
      project: {
        id: 'p1',
        root: 'C:/proj',
        manifest: { crs: { kind: 'local' }, origin: [0, 0, 0], layers: h.layers },
      },
    }),
}));

vi.mock('@aio/engine', () => {
  const stage = {
    layerLoaded: () => h.loaded,
    onLayerLoaded: () => () => undefined,
  };
  return { getActiveStage: () => stage, onActiveScene: () => () => undefined };
});

vi.mock('../telecom/antennaScene', () => ({
  attachAntennaLayer: (_stage: unknown, _frame: unknown, opts: { onPick(id: string): void }) => {
    h.layerPick = (id) => {
      opts.onPick(id);
    };
    return () => undefined;
  },
  armTowerPick: vi.fn((_stage: unknown, cb: (p: [number, number, number]) => void) => {
    h.pick = cb;
    return () => undefined;
  }),
}));

vi.mock('../builder/photoOpen', () => ({ openPhoto: () => undefined }));

const shell = await import('../shell');
// eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn, no `this`
const bridgeCall = vi.mocked(shell.bridge.call);
const scene = await import('../telecom/antennaScene');

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };
const sample = (): AntennasFile => {
  const f = AntennasFile.parse(structuredClone(contract.example));
  return { ...f, units: f.units.map((u) => ({ ...u, status: 'accepted' as const })) };
};

const cloud = { kind: 'pointcloud', id: 'cloud-1', name: 'Cloud', visible: true };
const mesh = { kind: 'mesh', id: 'mesh-1', name: 'Mesh', visible: true };

let host: HTMLElement;
let root: Root;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
async function mount() {
  act(() => {
    root.render(<DetectAntennas />);
  });
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const text = () => document.body.textContent;
const channels = (name: string) => h.calls.filter(([c]) => c === name);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  h.disk = sample();
  h.calls = [];
  h.replies = {};
  h.layers = [cloud];
  h.loaded = true;
  h.pick = null;
  h.layerPick = null;
  localStorage.clear();
  bridgeCall.mockClear();
  antennaStore.setState({
    projectId: null,
    root: null,
    file: null,
    readOnly: false,
    status: 'idle',
    message: null,
    jobId: null,
    running: false,
    needsHint: false,
    selected: null,
    hidden: {},
    cloudLayer: null,
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('DetectAntennas', () => {
  it('is hidden without a point cloud', async () => {
    h.layers = [mesh];
    await mount();
    expect(host.innerHTML).toBe('');
    expect(channels('telecom:readAntennas')).toHaveLength(0);
  });

  it('reads the inventory on mount and shows the panel', async () => {
    await mount();
    expect(channels('telecom:readAntennas')).toHaveLength(1);
    expect(antennaStore.getState().root).toBe('C:/proj');
    expect(q('[data-testid="antenna-panel"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="antenna-row"]')).toHaveLength(3);
  });

  it('is disabled with a reason while running and while the cloud loads', async () => {
    await mount();
    const button = q('[data-testid="detect-antennas"]')!;
    expect(button.getAttribute('aria-disabled')).toBeNull();

    h.loaded = false;
    act(() => {
      antennaStore.setState({ message: null });
      root.render(<DetectAntennas />);
    });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toContain('The point cloud is still loading.');

    h.loaded = true;
    act(() => {
      antennaStore.setState({ running: true });
    });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toContain('Antenna detection is already running.');
  });

  it('starts detection on click', async () => {
    await mount();
    act(() => {
      q('[data-testid="detect-antennas"]')!.click();
    });
    const starts = channels('jobs:start');
    expect(starts).toHaveLength(1);
    expect(starts[0]![1]).toMatchObject({ pipeline: 'telecom.antennas', project: 'C:/proj' });
  });

  it('asks for a tower click after a hint failure and re-runs with it', async () => {
    await mount();
    act(() => {
      antennaStore.setState({ needsHint: true });
    });
    expect(q('[data-testid="antenna-hint"]')?.textContent).toContain('Click the tower once');
    expect(scene.armTowerPick).toHaveBeenCalled();
    act(() => {
      h.pick!([4, 7, 9]);
    });
    await flush();
    const starts = channels('jobs:start');
    expect(starts).toHaveLength(1);
    const params = (starts[0]![1] as { params: { towerHint?: number[] } }).params;
    expect(params.towerHint).toEqual([4, 9]);
    expect(antennaStore.getState().needsHint).toBe(false);
  });

  /** A finished run: the store runs, then holds a new file. */
  async function finishRun() {
    setAiLabelPref('p1', true);
    await mount();
    act(() => {
      antennaStore.setState({ running: true });
    });
    const next = sample();
    act(() => {
      antennaStore.setState({
        running: false,
        file: { ...next, run: { ...next.run, id: 'run-b' } },
        status: 'ready',
      });
    });
    await flush();
  }

  it('shows the AI refusal and keeps the inventory', async () => {
    h.replies['ai:antennaLabelPreview'] = { ok: true, value: { ok: false, error: 'offline' } };
    await finishRun();
    expect(channels('ai:antennaLabelPreview')).toHaveLength(1);
    expect(text()).toContain('AI labelling skipped: offline');
    expect(host.querySelectorAll('[data-testid="antenna-row"]')).toHaveLength(3);
    expect(channels('ai:labelAntennas')).toHaveLength(0);
  });

  it('previews, sends and applies AI labels', async () => {
    h.replies['ai:antennaLabelPreview'] = {
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
    await finishRun();
    const send = document.querySelector<HTMLElement>('[data-testid="antenna-send"]')!;
    expect(send.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      send.click();
    });
    await flush();
    const label = channels('ai:labelAntennas');
    expect(label).toHaveLength(1);
    expect(label[0]![1]).toMatchObject({ projectId: 'p1', token: 'tok-1', photos: true });
    expect(String(label[0]![1].runId)).toMatch(/^ai-/);
    const unit = antennaStore.getState().file!.units.find((u) => u.id === 'ant-o1')!;
    expect(unit.kindBasis).toBe('ai');
    expect(unit.ai?.provider).toBe('anthropic');
    expect(channels('telecom:writeAntennas').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="antenna-send"]')).toBeNull();
  });

  it('selects a picked unit and scrolls its row into view', async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    await mount();
    act(() => {
      h.layerPick!('ant-d1');
    });
    expect(antennaStore.getState().selected).toBe('ant-d1');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('exports the CSV through the save dialog', async () => {
    h.replies['dialog:saveFile'] = { ok: true, value: { path: 'C:/out/antenna-inventory.csv' } };
    await mount();
    act(() => {
      q('[data-testid="antenna-csv"]')!.click();
    });
    await flush();
    const save = channels('dialog:saveFile');
    expect(save).toHaveLength(1);
    expect(save[0]![1]).toMatchObject({ defaultName: 'antenna-inventory.csv' });
    expect(String(save[0]![1].data).startsWith(CSV_COLUMNS.join(','))).toBe(true);
    expect(text()).toContain('Exported to C:/out/antenna-inventory.csv.');
  });
});

describe('AntennaSendPreview', () => {
  const base = {
    ok: true as const,
    provider: 'anthropic',
    model: 'm1',
    cloud: true,
    photosAllowed: false,
    crops: [{ unitId: 'ant-a3', path: 'telecom/crops/ant-a3.jpg' }],
    missing: [],
    estimate: { images: 1, inputTokens: 900 },
    token: 'tok',
  };

  it('needs the photo consent for a cloud request and passes it on', () => {
    const onSend = vi.fn();
    act(() => {
      root.render(
        <AntennaSendPreview preview={base} projectId="p1" onSend={onSend} onCancel={vi.fn()} />,
      );
    });
    const send = document.querySelector<HTMLElement>('[data-testid="antenna-send"]')!;
    expect(send.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      send.click();
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('1 crop leaves this computer for Anthropic.');
    act(() => {
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    // the button is rebuilt when its reason goes away
    const ready = document.querySelector<HTMLElement>('[data-testid="antenna-send"]')!;
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      ready.click();
    });
    expect(onSend).toHaveBeenCalledWith(true);
  });
});
