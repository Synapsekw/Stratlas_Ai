// @vitest-environment jsdom
/**
 * The review queue: one suggestion at a time with its crop, Accept, Fix and Not a fault, class
 * chips, the Waiting / Accepted / Rejected filter, one confidence slider, Accept all of a class
 * above the slider and Reject all of a class, undo and redo. Finishing the queue leaves it.
 */
import { setAnnotateReadOnly } from '@aio/annotate';
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { ProjectManifest } from '@aio/schema';
import { TIP_DELAY_MS } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the app's bridge binds to window.aio when its module loads: answer every write with ok
vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  };
});
vi.mock('../detections/prepare', () => ({
  frameImage: () => Promise.resolve({ dataUrl: 'data:,', width: 10, height: 10 }),
}));

import { detections } from '../detections/store';
import { toasts } from '../exports/exports';
import { askAiPrefs, readPrefs, setAskAiPrefs } from './askAi/prefs';
import { visibleDetections } from './findings';
import { inspectUi, openQueue } from './inspectUi';
import { queueCommand, ReviewQueue } from './ReviewQueue';

const NOW = '2026-10-15T10:00:00.000Z';
const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [photo('p001'), photo('p002'), photo('p003'), photo('p004'), photo('p005')],
    },
  ],
  severityModels: [
    {
      id: 'sev3',
      name: 'Three',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'Major', color: '#ff2d2d', criteria: '' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Kit',
      assetType: 'site',
      classes: [
        { id: 'corrosion', label: 'Corrosion', color: '#aa5500', severityModel: 'sev3' },
        { id: 'crack', label: 'Crack', color: '#aa0000', severityModel: 'sev3' },
      ],
    },
  ],
};

const src = (p: string): Detection['source'] => ({ kind: 'photo', layer: 'photos', photo: p });

const det = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'ai-r1.json',
  source: src('p001'),
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'corrosion',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/** Three waiting (Corrosion 0.9, Crack 0.85, Corrosion 0.3) and one rejected. */
const FIXTURE: Detection[] = [
  det('d1', { source: src('p001') }),
  det('d2', { classId: 'crack', confidence: 0.85, source: src('p002') }),
  det('d3', { confidence: 0.3, source: src('p003') }),
  det('d4', { status: 'rejected', source: src('p004') }),
];

function load(list: Detection[], readOnly = false) {
  detections.setState({
    projectId: 'p1',
    readOnly,
    review: reviewReducer(initialReview(), { type: 'load', detections: list }),
  });
}

let host: HTMLDivElement;
let root: Root;
const onFix = vi.fn();
const onNeedsPicker = vi.fn();

beforeEach(() => {
  setAnnotateReadOnly(false);
  localStorage.clear();
  setAskAiPrefs({ queueThreshold: 0 });
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, []);
  load(FIXTURE);
  openQueue(null);
  onFix.mockReset();
  toasts.getState().dismiss('inspect-queue-done');
  onNeedsPicker.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview(), readOnly: false });
});

async function mount(readOnly = false) {
  await act(async () => {
    root.render(
      <ReviewQueue
        projectId="p1"
        manifest={manifest}
        readOnly={readOnly}
        onFix={onFix}
        onNeedsPicker={onNeedsPicker}
      />,
    );
    await Promise.resolve();
  });
}

const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Hovers a control and returns the text of the tip it opens. */
function tipOf(el: HTMLElement | null): string | undefined {
  vi.useFakeTimers();
  try {
    act(() => {
      el?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
  } finally {
    vi.useRealTimers();
  }
  return document.querySelector('[role="tooltip"]')?.textContent ?? undefined;
}
const text = (id: string) => byId(id)?.textContent ?? '';
const find = (id: string) => detections.getState().review.detections.find((d) => d.id === id);

async function click(id: string) {
  const el = byId(id);
  if (!el) throw new Error(`no ${id}`);
  await act(async () => {
    el.click();
    // the accepts are async (a photo's size may be read first)
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function slide(value: number) {
  const input = byId('queue-threshold') as HTMLInputElement;
  await act(async () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = desc?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function filterTo(label: string) {
  const btn = [
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="queue-filter"] button'),
  ].find((b) => b.textContent === label);
  if (!btn) throw new Error(`no filter ${label}`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
}

describe('ReviewQueue', () => {
  // first in the file: React warns about a missing key only once per component
  it('keys every severity button', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await mount();
      expect(errors.mock.calls.flat().join(' ')).not.toContain('unique "key"');
    } finally {
      errors.mockRestore();
    }
  });

  it('shows where you are in the queue and steps on accept', async () => {
    await mount();
    expect(byId('queue-progress')).not.toBeNull();
    expect(text('queue-progress')).toBe('1 of 3');
    await click('queue-accept');
    expect(find('d1')?.status).toBe('accepted');
    expect(text('queue-progress')).toBe('1 of 2');
    expect(detections.getState().review.currentId).toBe('d2');
  });

  it('starts the slider at 50 % in a fresh project: a 0.4 suggestion is hidden, a 0.6 one shows', async () => {
    // nothing set by the person or in the Ask AI settings
    localStorage.clear();
    askAiPrefs.setState(readPrefs());
    load([det('low', { confidence: 0.4 }), det('mid', { confidence: 0.6, source: src('p002') })]);
    await mount();
    expect((byId('queue-threshold') as HTMLInputElement).value).toBe('0.5');
    expect(text('queue-progress')).toBe('1 of 1');
    expect(detections.getState().review.currentId).toBe('mid');
  });

  it('starts the slider at the Ask AI queue threshold', async () => {
    setAskAiPrefs({ queueThreshold: 0.5 });
    await mount();
    expect((byId('queue-threshold') as HTMLInputElement).value).toBe('0.5');
    expect(text('queue-progress')).toBe('1 of 2');
  });

  it('hides suggestions under the slider and does not count them', async () => {
    await mount();
    expect(text('det-counts')).toContain('3 waiting');
    await slide(0.5);
    expect(detections.getState().review.minConfidence).toBe(0.5);
    expect(text('queue-progress')).toBe('1 of 2');
    expect(text('det-counts')).toContain('2 waiting');
    expect(text('queue-class-corrosion')).toContain('1');
  });

  it('accepts all of one class above the slider value after the confirm', async () => {
    await mount();
    await slide(0.5);
    await click('queue-class-corrosion');
    expect(text('det-accept-all')).toContain('Corrosion');
    expect(text('det-accept-all')).toContain('(1)');
    await click('det-accept-all');
    expect(byId('det-batch-confirm')).not.toBeNull();
    expect(find('d1')?.status).toBe('draft');
    await click('det-batch-ok');
    expect(find('d1')?.status).toBe('accepted');
    expect(find('d3')?.status).toBe('draft');
    expect(find('d2')?.status).toBe('draft');
  });

  it('shows how many Accept all skipped', async () => {
    load([...FIXTURE, det('d5', { severity: null, confidence: 0.95, source: src('p005') })]);
    await mount();
    await click('queue-class-corrosion');
    await slide(0.5);
    await click('det-accept-all');
    await click('det-batch-ok');
    expect(find('d1')?.status).toBe('accepted');
    expect(find('d5')?.status).toBe('draft');
    expect(text('queue-skipped')).toContain('1 was skipped');
  });

  it('rejects all of one class after the confirm', async () => {
    await mount();
    await click('queue-class-corrosion');
    await click('det-reject-all');
    await click('det-batch-ok');
    expect(find('d1')?.status).toBe('rejected');
    expect(find('d3')?.status).toBe('rejected');
    expect(find('d2')?.status).toBe('draft');
  });

  it('filters by class chip and by Accepted and Rejected', async () => {
    await mount();
    expect(text('queue-class-all')).toContain('3');
    await click('queue-class-crack');
    expect(inspectUi.getState().queueClass).toBe('crack');
    expect(text('queue-progress')).toBe('1 of 1');
    expect(detections.getState().review.currentId).toBe('d2');
    await click('queue-class-all');
    await filterTo('Rejected');
    expect(text('queue-progress')).toBe('1 of 1');
    expect(detections.getState().review.currentId).toBe('d4');
    await filterTo('Accepted');
    expect(text('queue-progress')).toBe('0 of 0');
  });

  it('leaves the queue when the last suggestion is done', async () => {
    await mount();
    await click('queue-class-crack');
    await click('queue-not-fault');
    expect(find('d2')?.status).toBe('rejected');
    expect(find('d2')?.rejectReason).toBe('not-a-defect');
    expect(inspectUi.getState().panel).toBe('photo');
    const done = toasts
      .getState()
      .toasts.filter((x) => x.message === 'Every suggestion here is checked.');
    expect(done).toHaveLength(1);
  });

  it('steps with the next and previous buttons and the J and K commands', async () => {
    await mount();
    await click('queue-next');
    expect(text('queue-progress')).toBe('2 of 3');
    await act(async () => {
      queueCommand('prev');
      await Promise.resolve();
    });
    expect(text('queue-progress')).toBe('1 of 3');
  });

  it('accepts once for a held A while the first accept is pending', async () => {
    await mount();
    await act(async () => {
      expect(queueCommand('accept')).toBe(true);
      queueCommand('accept');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(find('d1')?.status).toBe('accepted');
    expect(find('d2')?.status).toBe('draft');
    // a second accept of the same draft would answer "is an issue now"
    expect(byId('queue-error')).toBeNull();
  });

  it('asks the screen for the picker when one key cannot accept', async () => {
    load([det('d9', { classId: '', severity: null })]);
    await mount();
    await click('queue-accept');
    expect(onNeedsPicker).toHaveBeenCalledWith('d9');
    expect(find('d9')?.status).toBe('draft');
  });

  it('keeps a draft relabelled under a class chip open until it is decided', async () => {
    await mount();
    await click('queue-class-crack');
    const select = byId('det-class') as HTMLSelectElement;
    await act(async () => {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = desc?.set;
      setter?.call(select, 'corrosion');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(find('d2')?.classId).toBe('corrosion');
    expect(inspectUi.getState().panel).toBe('queue');
    expect(detections.getState().review.currentId).toBe('d2');
    expect(text('queue-progress')).toBe('1 of 1');
    expect(toasts.getState().toasts.some((x) => x.id === 'inspect-queue-done')).toBe(false);
    await click('queue-accept');
    expect(find('d2')?.status).toBe('accepted');
    expect(inspectUi.getState().panel).toBe('photo');
  });

  it('Fix hands the draft to the screen', async () => {
    await mount();
    await click('queue-fix');
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it('changes the class and severity of the current suggestion', async () => {
    await mount();
    await click('queue-sev-3');
    expect(find('d1')?.severity).toBe(3);
  });

  it('undoes and redoes', async () => {
    await mount();
    await click('queue-not-fault');
    expect(text('queue-progress')).toBe('1 of 2');
    await click('queue-undo');
    expect(find('d1')?.status).toBe('draft');
    expect(text('queue-progress')).toBe('1 of 3');
    await click('queue-redo');
    expect(find('d1')?.status).toBe('rejected');
  });

  it('is view only in a read-only package', async () => {
    load(FIXTURE, true);
    await mount(true);
    for (const id of [
      'queue-accept',
      'queue-fix',
      'queue-not-fault',
      'det-accept-all',
      'det-reject-all',
      'queue-reject-reason',
    ]) {
      // aria-disabled, not disabled: a disabled button takes no hover or focus, so no tip
      expect((byId(id) as HTMLButtonElement).disabled, id).toBe(false);
      expect(byId(id)?.getAttribute('aria-disabled'), id).toBe('true');
      expect(tipOf(byId(id)), id).toBe('This package is read only.');
    }
    await click('queue-accept');
    await click('queue-not-fault');
    await click('det-accept-all');
    await click('queue-reject-reason');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(byId('det-batch-confirm')).toBeNull();
    expect(find('d1')?.status).toBe('draft');
    expect(queueCommand('accept')).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(find('d1')?.status).toBe('draft');
    // looking, filtering and stepping still work
    await click('queue-next');
    expect(text('queue-progress')).toBe('2 of 3');
    await click('queue-class-crack');
    expect(text('queue-progress')).toBe('1 of 1');
  });

  /** A local detector's draft: it carries a score and its detector. */
  const detectorDraft = (id: string, over: Partial<Detection> = {}) =>
    det(id, {
      pass: 'vlm-run-a.json',
      origin: {
        kind: 'model',
        producer: 'local',
        detector: { id: 'rust', version: 1, modelSha256: 'a'.repeat(64), threshold: 0.6 },
      },
      ...over,
    });

  it('the caret on a detector draft asks why before it dismisses', async () => {
    load([detectorDraft('m1')]);
    await mount();
    expect(byId('queue-reject-reason')?.getAttribute('aria-haspopup')).toBe('menu');
    await click('queue-reject-reason');
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const item = [...(menu?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Wrong class',
    );
    await act(async () => {
      item?.click();
      await Promise.resolve();
    });
    expect(find('m1')?.status).toBe('rejected');
    expect(find('m1')?.rejectReason).toBe('wrong-class');
  });

  it('D or X on a detector draft dismisses it at once, with no menu', async () => {
    load([detectorDraft('m1')]);
    await mount();
    await act(async () => {
      expect(queueCommand('dismiss')).toBe(true);
      await Promise.resolve();
    });
    expect(find('m1')?.status).toBe('rejected');
    expect(find('m1')?.rejectReason).toBe('not-a-defect');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it('arrow keys on the slider do not step the queue', async () => {
    await mount();
    const seen = vi.fn();
    document.body.addEventListener('keydown', seen);
    const slider = byId('queue-threshold');
    await act(async () => {
      for (const key of ['ArrowRight', 'j', 'x']) {
        slider?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      await Promise.resolve();
    });
    document.body.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
    expect(text('queue-progress')).toBe('1 of 3');
    expect(['d1', 'd2', 'd3'].map((id) => find(id)?.status)).toEqual(['draft', 'draft', 'draft']);
  });

  it('raising the slider takes the hidden draft out of the viewer', async () => {
    load([det('m1', { confidence: 0.9 }), det('m2', { confidence: 0.7, source: src('p002') })]);
    await mount();
    const shown = () => visibleDetections(detections.getState().review).map((d) => d.id);
    expect(text('det-counts')).toContain('2 waiting');
    expect(shown()).toEqual(['m1', 'm2']);
    await slide(0.8);
    expect(text('det-counts')).toContain('1 waiting');
    expect(shown()).toEqual(['m1']);
  });

  it('runs no command when no queue is open', () => {
    expect(queueCommand('accept')).toBe(false);
  });
});
