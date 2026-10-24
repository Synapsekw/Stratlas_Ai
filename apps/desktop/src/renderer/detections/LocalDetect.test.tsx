// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWalkView, setWalkView } from '../walks/walkView';
import type { DetectItem } from './convert';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  call: vi.fn(),
  models: {
    ok: true,
    value: {
      runtime: { available: true, provider: 'cpu' },
      models: [
        {
          id: 'ppe',
          card: {
            name: 'PPE',
            version: '1',
            classes: ['person'],
            minConfidence: 0.3,
            input: { width: 640, height: 640 },
          },
        },
      ],
    },
  },
}));

vi.mock('@aio/annotate', () => ({
  NEW_CLASS_OPTION: '__new-class__',
  NewClassRow: () => null,
  useNewClass: () => ({ create: null, disabledReason: null }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (s: { project: null }) => unknown) => sel({ project: null }),
}));
vi.mock('../shell', () => ({ bridge: { call: h.call }, useCall: () => h.models }));
vi.mock('./store', () => ({ loadDetections: () => Promise.resolve() }));
vi.mock('../screens/settings/DetectionModels', () => ({ providerLabel: () => 'CPU' }));

const { LocalDetectDialog } = await import('./LocalDetect');

const walk = (id: string, durationS: number) =>
  ({
    kind: 'walk',
    id,
    name: `Walk ${id}`,
    durationS,
    record: 'walks/w/record.mp4',
    src: 'walks/w/playback.mp4',
  }) as unknown as Layer;

const photo: DetectItem = { kind: 'photo', layer: 'p', photo: 'a' };

/** A 360 pane at `t` seconds into its walk. */
const view = (t: number) => ({ t, lookDeg: null, pitchDeg: 0, fovDeg: 90, hfovDeg: 120 });

let host: HTMLDivElement;
let root: Root;
/** The dialog's `inference:progress` listener. */
let onProgress: ((e: unknown) => void) | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  h.call.mockReset();
  h.call.mockResolvedValue({ ok: true, value: { ok: true, count: 0 } });
  onProgress = null;
  (window as unknown as { aio: unknown }).aio = {
    on: (_channel: string, fn: (e: unknown) => void) => {
      onProgress = fn;
      return () => undefined;
    },
  };
  window.localStorage.clear();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  clearWalkView('w1');
  clearWalkView('w2');
});

const q = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => {
    q(id)?.click();
  });
};

function open(layers: readonly Layer[], selected: readonly DetectItem[] = []) {
  act(() => {
    root.render(
      <LocalDetectDialog
        projectId="proj"
        layers={layers}
        selected={selected}
        current={null}
        unreviewed={[]}
        onMode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  });
}

async function run() {
  await act(async () => {
    q('det-local-run')?.click();
    await Promise.resolve();
  });
  const call = h.call.mock.calls.find((c) => c[0] === 'inference:run');
  return call?.[1] as { items: unknown[]; tile?: unknown };
}

describe('LocalDetectDialog, 360 video frames', () => {
  it('opens on the walk scope and samples one frame every 2 s by default', async () => {
    open([walk('w1', 10)]);
    expect(q('det-local-scope-walk')?.checked).toBe(true);
    expect(q('det-local-every-2')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('det-local-frames-count')?.textContent).toBe('5 frames');
    expect(q('det-local-run')?.textContent).toBe('Run on 5 frames');
    const req = await run();
    expect(req.items).toEqual([1, 3, 5, 7, 9].map((t) => ({ layer: 'w1', t })));
    expect('tile' in req).toBe(false);
  });

  it('changes the interval with the segmented control', () => {
    open([walk('w1', 10)]);
    click('det-local-every-5');
    expect(q('det-local-every-5')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('det-local-run')?.textContent).toBe('Run on 2 frames');
  });

  it('runs on the current frame only while a 360 pane shows that walk', async () => {
    setWalkView('w2', view(3));
    open([walk('w1', 10), walk('w2', 20)]);
    expect(q('det-local-current-frame')?.disabled).toBe(true);
    act(() => {
      setWalkView('w1', view(4.25));
    });
    const cur = q('det-local-current-frame');
    expect(cur?.disabled).toBe(false);
    expect(cur?.parentElement?.textContent).toBe('Current frame (4.3 s)');
    click('det-local-current-frame');
    expect(q('det-local-run')?.textContent).toBe('Run on 1 frame');
    const req = await run();
    expect(req.items).toEqual([{ layer: 'w1', t: 4.25 }]);
  });

  it('sends the tile options when tiles are on', async () => {
    open([walk('w1', 4)]);
    click('det-local-walk-tile');
    const req = await run();
    expect(req.tile).toEqual({ size: 640, overlap: 128 });
    expect(req.items).toEqual([1, 3].map((t) => ({ layer: 'w1', t })));
  });

  it('caps a long walk at 2000 frames and says so', () => {
    open([walk('w1', 3000)]);
    click('det-local-every-1');
    expect(q('det-local-run')?.textContent).toBe('Run on 2000 frames');
    expect(q('det-local-frames-capped')?.textContent).toContain('At most 2000 frames per run');
    click('det-local-every-2');
    expect(q('det-local-frames-capped')).toBeNull();
  });

  it('counts progress in frames', async () => {
    open([walk('w1', 10)]);
    await run();
    expect(q('det-local-progress')?.textContent).toContain('0 of 5 frames checked, 0 found');
  });

  it('says how many frames could not be read and why, while running and when done', async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.call.mockImplementation((channel: string) =>
      channel === 'inference:run'
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve({ ok: true, value: { ok: true } }),
    );
    open([walk('w1', 10)]);
    const req = (await run()) as unknown as { runId: string };
    const codec = "this video's codec can't be read";
    act(() => {
      onProgress?.({ runId: req.runId, done: 2, total: 5, found: 0, skipped: 1, reason: codec });
    });
    expect(q('det-local-skipped')?.textContent).toBe('1 frame could not be read');
    expect(q('det-local-skipped-reason')?.textContent).toBe(codec);
    await act(async () => {
      onProgress?.({ runId: req.runId, done: 5, total: 5, found: 0, skipped: 2, reason: codec });
      finish({
        ok: true,
        value: { ok: true, file: 'detections/model-x.json', count: 0, skipped: 2, reason: codec },
      });
      await Promise.resolve();
    });
    expect(host.querySelector('h3')?.textContent).toBe('Done');
    expect(q('det-local-skipped')?.textContent).toBe('2 frames could not be read');
    expect(q('det-local-skipped-reason')?.textContent).toBe(codec);
    // the frames not read are not assessed: the same run tries them again
    expect(q('det-local-rest')?.textContent).toBe('Run the remaining 2');
  });

  it('shows the error state, not Done, when no frame could be read', async () => {
    const error =
      'None of the 5 frames could be read: ffmpeg could not be started (ffmpeg): spawn ffmpeg ENOENT';
    h.call.mockResolvedValue({ ok: true, value: { ok: false, error } });
    open([walk('w1', 10)]);
    await act(async () => {
      q('det-local-run')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('h3')?.textContent).toBe('Stopped by an error');
    expect(q('det-local-error')?.textContent).toBe(error);
  });

  it('words a skipped photo as a photo', async () => {
    h.call.mockResolvedValue({
      ok: true,
      value: { ok: true, file: 'f', count: 0, skipped: 1, reason: 'Could not decode a.jpg' },
    });
    open([], [photo]);
    await act(async () => {
      q('det-local-run')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q('det-local-skipped')?.textContent).toBe('1 photo could not be read');
  });

  it('keeps photos as they were and shows the walk scope disabled without a 360 video', async () => {
    open([], [photo]);
    expect(q('det-local-scope-walk')?.disabled).toBe(true);
    expect(host.textContent).toContain('Add a 360 video to detect on its frames.');
    expect(q('det-local-scope-selected')?.checked).toBe(true);
    expect(q('det-local-run')?.textContent).toBe('Run on 1 photo');
    const req = await run();
    expect(req.items).toEqual([{ layer: 'p', photo: 'a' }]);
  });
});
