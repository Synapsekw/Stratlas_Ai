// @vitest-environment jsdom
import {
  VLM_DETECTOR_SCHEMA,
  type DetectorWhere,
  type HardwareCheck,
  type IpcResponse,
  type VlmDetector,
} from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectItem } from '../convert';

const h = vi.hoisted(() => ({
  answers: new Map<string, (req: unknown) => unknown>(),
  calls: [] as { channel: string; req: unknown }[],
  start: vi.fn<(req: unknown) => Promise<string | null>>(),
}));

vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string, req: unknown) => {
      h.calls.push({ channel, req });
      const a = h.answers.get(channel);
      if (!a) return Promise.resolve({ ok: false, error: `no ${channel}` });
      return Promise.resolve(a(req)).then((value) => ({ ok: true, value }));
    },
  },
  jobs: { getState: () => ({ start: h.start }) },
}));

import { analyticsPack } from '../../analyticsPack';
import { readMode } from '../LocalDetect';
import { DetectorRunDialog } from './DetectorRunDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = IpcResponse<'detectors:list'>['items'][number];
type Stats = IpcResponse<'ledger:stats'>;
type Status = IpcResponse<'analyticsPack:status'>;

const SHA = 'a'.repeat(64);
const det = (id: string, over: Partial<VlmDetector> = {}): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version: 1,
  classId: 'patch',
  assetTypes: ['roof'],
  looksLike: 'a dark patch',
  ignore: '',
  question: 'Is this a dark patch?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen', modelSha256: SHA },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'verified',
  ...over,
});
const item = (where: DetectorWhere, d: VlmDetector, modelMismatch = false): Item => ({
  where,
  detector: d,
  modelMismatch,
});

const NONE: Stats = { accepted: 0, rejected: 0, misses: 0, suggestedThreshold: null };
const INSTALLED: Status = {
  installed: { version: '1.0.0', dir: 'D:\\data\\analytics-pack-1.0.0' },
  offer: null,
  unusable: [],
};
const CARD: HardwareCheck = {
  ok: true,
  gpu: 'NVIDIA RTX',
  gpuIndex: 0,
  totalMb: 16384,
  freeMb: 12000,
};

const photos = (n: number, layer = 'd1'): DetectItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'photo', layer, photo: `p${String(i)}` }));

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn<() => void>>;

/** Main's answers for a computer that can run detectors, with one roof and one tower detector. */
function canRun(): void {
  h.answers.set('analyticsPack:status', () => INSTALLED);
  h.answers.set('analytics:hardware', () => CARD);
  h.answers.set('detectors:list', () => ({
    items: [item('library', det('rust')), item('shipped', det('tower', { assetTypes: ['mast'] }))],
  }));
  h.answers.set('ledger:stats', () => NONE);
  h.answers.set('detect:queue', () => ({ items: [] }));
}

beforeEach(() => {
  h.answers.clear();
  h.calls.length = 0;
  h.start.mockReset();
  h.start.mockResolvedValue(null);
  analyticsPack.setState(analyticsPack.getInitialState());
  workspace.setState({
    project: {
      id: 'proj',
      root: 'D:\\projects\\site',
      manifest: {
        classCatalogues: [
          {
            id: 'c1',
            name: 'Roof',
            assetType: 'roof',
            classes: [{ id: 'patch', label: 'Patch', color: '#ff0000', severityModel: 's' }],
          },
        ],
      },
    } as unknown as OpenProject,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onClose = vi.fn<() => void>();
  window.localStorage.clear();
  canRun();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => q(id)?.textContent ?? '';
const startDisabled = () => q('det-vlm-start')?.getAttribute('aria-disabled') === 'true';

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(selected: readonly DetectItem[] = photos(240)) {
  act(() => {
    root.render(
      <DetectorRunDialog
        projectId="proj"
        selected={selected}
        current={null}
        unreviewed={[]}
        onMode={vi.fn()}
        onClose={onClose}
      />,
    );
  });
  await flush();
}

async function click(id: string) {
  await act(async () => {
    q(id)?.click();
    await Promise.resolve();
  });
  await flush();
}

describe('DetectorRunDialog', () => {
  it('is the third choice of the mode switch, remembered like the others', async () => {
    await open();
    const mine = q('det-mode-detectors') as HTMLInputElement | null;
    expect(mine?.checked).toBe(true);
    expect(mine?.parentElement?.textContent).toBe('Detectors (on this computer)');
    window.localStorage.setItem('stratlas.detect.mode', 'detectors');
    expect(readMode()).toBe('detectors');
    await click('det-mode-local');
    expect(window.localStorage.getItem('stratlas.detect.mode')).toBe('local');
    expect(readMode()).toBe('local');
  });

  it('Start is disabled without the pack', async () => {
    h.answers.set('analyticsPack:status', () => ({ ...INSTALLED, installed: null }));
    await open();
    await click('det-vlm-det-rust');
    expect(startDisabled()).toBe(true);
    expect(text('det-vlm-blocker')).toBe(
      'Install the Analytics pack in Settings to run detectors.',
    );
  });

  it('names why an installed pack cannot be used', async () => {
    h.answers.set('analyticsPack:status', () => ({
      ...INSTALLED,
      installed: null,
      unusable: [{ version: '0.9.0', reason: 'Analytics pack 0.9.0 does not work here.' }],
    }));
    await open();
    expect(text('det-vlm-blocker')).toBe('Analytics pack 0.9.0 does not work here.');
  });

  it('a failed pack status read says why and can be tried again', async () => {
    h.answers.delete('analyticsPack:status');
    await open();
    expect(text('det-vlm-blocker')).toBe('no analyticsPack:status');
    h.answers.set('analyticsPack:status', () => INSTALLED);
    await click('det-vlm-pack-retry');
    expect(text('det-vlm-blocker')).toBe('Choose at least one detector.');
    expect(q('det-vlm-pack-retry')).toBeNull();
  });

  it('on a Mac the Mac refusal is the reason, not the missing pack', async () => {
    const reason = 'Detectors need a Windows computer with an NVIDIA graphics card.';
    h.answers.set('analyticsPack:status', () => ({ installed: null, offer: null, unusable: [] }));
    h.answers.set('analytics:hardware', () => ({ ok: false, code: 'mac', reason }));
    await open();
    await click('det-vlm-det-rust');
    expect(startDisabled()).toBe(true);
    expect(text('det-vlm-blocker')).toBe(reason);
    expect(q('det-vlm-hw-recheck')).toBeNull();
  });

  it('Start is disabled on a hardware refusal except too busy', async () => {
    const busy = 'Only 3.1 GB of graphics memory is free; detectors need about 6.5 GB.';
    h.answers.set('analytics:hardware', () => ({ ok: false, code: 'tooBusy', reason: busy }));
    await open();
    await click('det-vlm-det-rust');
    expect(text('det-vlm-hw')).toContain('Only 3.1 GB of graphics memory is free');
    expect(q('det-vlm-hw')?.className).toContain('warn');
    expect(startDisabled()).toBe(false);
    expect(q('det-vlm-blocker')).toBeNull();
    // Check again asks main once more, and a card that is free now clears the notice
    h.answers.set('analytics:hardware', () => CARD);
    const before = h.calls.filter((c) => c.channel === 'analytics:hardware').length;
    await click('det-vlm-hw-recheck');
    expect(h.calls.filter((c) => c.channel === 'analytics:hardware').length).toBe(before + 1);
    expect(q('det-vlm-hw')).toBeNull();

    for (const code of ['noGpu', 'tooSmall', 'oldGpu', 'oldDriver', 'mac'] as const) {
      const reason = `Refused: ${code}.`;
      h.answers.set('analytics:hardware', () => ({ ok: false, code, reason }));
      act(() => {
        root.unmount();
      });
      root = createRoot(host);
      await open();
      await click('det-vlm-det-rust');
      expect(startDisabled(), code).toBe(true);
      expect(text('det-vlm-blocker'), code).toBe(reason);
    }
  });

  it('only video frames selected disables Start', async () => {
    await open([
      { kind: 'frame', layer: 'v1', t: 1 },
      { kind: 'frame', layer: 'v1', t: 3 },
    ]);
    await click('det-vlm-det-rust');
    expect(startDisabled()).toBe(true);
    expect(text('det-vlm-blocker')).toBe(
      'Detectors run on photos. Select photos, not video frames.',
    );
  });

  it('names a selection of video frames as frames, not as photos', async () => {
    await open([
      { kind: 'frame', layer: 'v1', t: 1 },
      { kind: 'frame', layer: 'v1', t: 3 },
    ]);
    expect(q('det-vlm-scope-selected')?.parentElement?.textContent).toBe(
      'The 2 selected video frames',
    );
  });

  it('says that video frames in a mixed selection are skipped', async () => {
    await open([...photos(2), { kind: 'frame', layer: 'v1', t: 1 }]);
    expect(text('det-vlm-frames-skipped')).toBe(
      '1 video frame is skipped: detectors run on photos.',
    );
  });

  it('no detector chosen disables Start', async () => {
    await open();
    expect(startDisabled()).toBe(true);
    expect(text('det-vlm-blocker')).toBe('Choose at least one detector.');
    await click('det-vlm-det-rust');
    expect(q('det-vlm-det-rust')?.getAttribute('aria-pressed')).toBe('true');
    expect(startDisabled()).toBe(false);
  });

  it('more than ten detectors disables Start', async () => {
    const ids = Array.from({ length: 11 }, (_, n) => `d${String(n)}`);
    h.answers.set('detectors:list', () => ({ items: ids.map((id) => item('library', det(id))) }));
    await open();
    for (const id of ids.slice(0, 10)) await click(`det-vlm-det-${id}`);
    expect(startDisabled()).toBe(false);
    await click('det-vlm-det-d10');
    expect(startDisabled()).toBe(true);
    expect(text('det-vlm-blocker')).toBe('Choose at most 10 detectors for one run.');
  });

  it('the blocker reason is visible next to Start', async () => {
    await open();
    const footer = q('det-vlm-start')?.closest('.dlg-f');
    const blocker = q('det-vlm-blocker');
    expect(blocker).not.toBeNull();
    expect(footer?.contains(blocker ?? null)).toBe(true);
    expect(q('det-vlm-start')?.textContent).toContain('Choose at least one detector.');
  });

  it("lists the project's asset type first, then all detectors", async () => {
    await open();
    const groups = [...host.querySelectorAll('[data-testid^="det-vlm-group-"]')];
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual([
      'det-vlm-group-project',
      'det-vlm-group-all',
    ]);
    expect(groups[0]?.querySelector('[data-testid="det-vlm-det-rust"]')).not.toBeNull();
    expect(groups[1]?.textContent).toContain('All detectors');
    expect(groups[1]?.querySelector('[data-testid="det-vlm-det-tower"]')).not.toBeNull();
  });

  it('an experimental detector and a model mismatch are labelled', async () => {
    h.answers.set('detectors:list', () => ({
      items: [item('library', det('rust', { status: 'experimental' }), true)],
    }));
    await open();
    expect(text('det-vlm-experimental-rust')).toBe('Experimental');
    expect(q('det-vlm-mismatch-rust')?.getAttribute('aria-label')).toBe(
      'This detector was tuned on a different model, so its results may differ.',
    );
  });

  it('the suggested threshold shows with Use and is not applied until clicked', async () => {
    h.answers.set('ledger:stats', () => ({ ...NONE, accepted: 9, suggestedThreshold: 0.65 }));
    await open();
    await click('det-vlm-det-rust');
    const slider = () => q('det-vlm-threshold-rust')?.querySelector('input');
    expect(slider()?.value).toBe('0.8');
    expect(slider()?.min).toBe('0.5');
    expect(text('det-vlm-suggested-rust')).toContain('Suggested 0.65');
    await click('det-vlm-use-rust');
    expect(slider()?.value).toBe('0.65');
    // applied: the suggestion stays as a note, without Use
    expect(text('det-vlm-suggested-rust')).toContain('Suggested 0.65');
    expect(q('det-vlm-use-rust')).toBeNull();
    await click('det-vlm-start');
    const req = h.start.mock.calls[0]?.[0] as {
      params: { detectors: { threshold: number }[] };
    };
    expect(req.params.detectors[0]?.threshold).toBe(0.65);
  });

  it('snaps a suggested threshold to the slider and hides Use when it is the value', async () => {
    const stats: Record<string, number> = { rust: 0.63, tower: 0.42 };
    h.answers.set('ledger:stats', (req) => ({
      ...NONE,
      suggestedThreshold: stats[(req as { detectorId: string }).detectorId] ?? null,
    }));
    await open();
    await click('det-vlm-det-rust');
    await click('det-vlm-det-tower');
    expect(text('det-vlm-suggested-rust')).toContain('Suggested 0.65');
    expect(text('det-vlm-suggested-tower')).toContain('Suggested 0.50');
    stats.rust = 0.79;
    act(() => {
      root.unmount();
    });
    root = createRoot(host);
    await open();
    await click('det-vlm-det-rust');
    // 0.79 snaps to 0.80, the detector's own value: nothing to use
    expect(text('det-vlm-suggested-rust')).toContain('Suggested 0.80');
    expect(q('det-vlm-use-rust')).toBeNull();
  });

  it('shows the estimate', async () => {
    await open();
    await click('det-vlm-det-rust');
    expect(text('det-vlm-estimate')).toBe('About 28 min for 240 photos');
  });

  it('starting one run closes the dialog', async () => {
    await open(photos(2));
    await click('det-vlm-det-rust');
    await click('det-vlm-start');
    expect(h.start).toHaveBeenCalledTimes(1);
    const req = h.start.mock.calls[0]?.[0] as {
      params: { run: string };
    };
    expect(req).toEqual({
      pipeline: 'detect.vlm',
      project: 'D:\\projects\\site',
      params: {
        run: req.params.run,
        layer: 'd1',
        photos: ['p0', 'p1'],
        detectors: [{ where: 'library', detector: det('rust'), threshold: 0.8 }],
      },
    });
    expect(req.params.run).toMatch(/^run-[a-z0-9-]{8}$/);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a queued answer says it will start when the card is free', async () => {
    h.start.mockResolvedValue('Another run is using the graphics card.');
    h.answers.set('detect:queue', () => {
      const req = h.start.mock.calls[0]?.[0] as { params: { run: string } };
      return {
        items: [
          {
            run: req.params.run,
            layer: 'd1',
            photos: 2,
            detectors: ['Detector rust'],
            queuedAt: '2026-10-22T10:00:00.000Z',
          },
        ],
      };
    });
    await open(photos(2));
    await click('det-vlm-det-rust');
    await click('det-vlm-start');
    expect(text('det-vlm-queued')).toBe(
      'Another detector or processing run is using the graphics card. This one starts when it finishes.',
    );
    expect(onClose).not.toHaveBeenCalled();
    await click('det-vlm-ok');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the queued message counts as queued when the queue no longer lists the run', async () => {
    h.start.mockResolvedValue(
      'Another detector or processing run is using the graphics card. This one starts when it finishes.',
    );
    await open(photos(2));
    await click('det-vlm-det-rust');
    await click('det-vlm-start');
    expect(q('det-vlm-queued')).not.toBeNull();
    expect(q('det-vlm-error')).toBeNull();
  });

  it('Escape closes the dialog; while the model loads it closes without cancelling the start', async () => {
    const press = () => {
      act(() => {
        q('det-ai-dialog')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
    };
    await open(photos(2));
    press();
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    let answer: (v: string | null) => void = () => undefined;
    h.start.mockReturnValue(
      new Promise<string | null>((r) => {
        answer = r;
      }),
    );
    await click('det-vlm-det-rust');
    expect(q('det-vlm-loading')).toBeNull();
    await click('det-vlm-start');
    expect(text('det-vlm-loading')).toBe(
      'Loading the detector model on the graphics card. This can take a minute or two.',
    );
    press();
    expect(onClose).toHaveBeenCalledTimes(1);
    // the app unmounts the closed dialog; the start keeps running and finishes later
    act(() => {
      root.unmount();
    });
    await act(async () => {
      answer(null);
      await Promise.resolve();
    });
    await flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    // the finished start does not close (or touch) the dialog a second time
    expect(onClose).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it('the close button works while the model loads', async () => {
    h.start.mockReturnValue(new Promise<string | null>(() => undefined));
    await open(photos(2));
    await click('det-vlm-det-rust');
    await click('det-vlm-start');
    const x = host.querySelector<HTMLButtonElement>('.dlg-h button');
    expect(x?.disabled).toBe(false);
    act(() => x?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a double click on Start starts once', async () => {
    await open(photos(2));
    await click('det-vlm-det-rust');
    await act(async () => {
      q('det-vlm-start')?.click();
      q('det-vlm-start')?.click();
      await Promise.resolve();
    });
    await flush();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('a refused start shows why and stays open', async () => {
    h.start.mockResolvedValue('The detector model did not start: no exe');
    await open(photos(2));
    await click('det-vlm-det-rust');
    await click('det-vlm-start');
    expect(text('det-vlm-error')).toBe('The detector model did not start: no exe');
    expect(onClose).not.toHaveBeenCalled();
    expect(startDisabled()).toBe(false);
  });

  it('a detector whose class is missing says it will suggest the class', async () => {
    h.answers.set('detectors:list', () => ({
      items: [item('library', det('rust', { classId: 'corrosion' }))],
    }));
    await open();
    await click('det-vlm-det-rust');
    // the suggested class is named after the detector
    expect(text('det-vlm-class-missing-rust')).toBe(
      "Detector rust isn't a class in this project yet. Its findings will offer to add it.",
    );
  });
});
