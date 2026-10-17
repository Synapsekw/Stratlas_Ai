// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaRunner } from '../telecom/AntennaRunner';
import { AntennaSendPreview } from '../telecom/AntennaSendPreview';
import { antennaStore } from '../telecom/antennaStore';
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
  antennaShift: () => null,
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
/** The button, with the runner that reads the inventory in (the bench mounts both). */
const Bench = () => (
  <>
    <DetectAntennas />
    <AntennaRunner />
  </>
);
async function mount() {
  act(() => {
    root.render(<Bench />);
  });
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
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
    aiPreview: null,
    aiNote: null,
    reveal: 0,
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('DetectAntennas', () => {
  it('reads the inventory in and shows the button', async () => {
    await mount();
    expect(channels('telecom:readAntennas')).toHaveLength(1);
    expect(q('[data-testid="detect-antennas"]')).not.toBeNull();
  });

  it('is hidden without a point cloud', async () => {
    h.layers = [mesh];
    await mount();
    expect(host.innerHTML).toBe('');
    expect(channels('telecom:readAntennas')).toHaveLength(0);
  });

  it('is disabled with a reason while running and while the cloud loads', async () => {
    await mount();
    const button = q('[data-testid="detect-antennas"]')!;
    expect(button.getAttribute('aria-disabled')).toBeNull();

    h.loaded = false;
    act(() => {
      antennaStore.setState({ message: null });
      root.render(<Bench />);
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

  it('shows why a run failed next to the button, with no inventory yet', async () => {
    h.disk = null;
    await mount();
    expect(q('[data-testid="antenna-panel"]')).toBeNull();
    act(() => {
      antennaStore.setState({ message: 'No tower found.' });
    });
    expect(q('[data-testid="antenna-message"]')?.textContent).toBe('No tower found.');
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
