// @vitest-environment jsdom
/**
 * The findings on the open photo: the issues a person confirmed and the AI's waiting suggestions
 * in one list, with Accept, Change and Dismiss on each suggestion, Draw a finding, and the way on
 * to the next photo to review.
 */
import { annotateUi } from '@aio/annotate';
import type { Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FindingRow } from './findings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ detections: [] as unknown[] }));

vi.mock('./actions', () => ({
  acceptSuggestion: vi.fn(() => Promise.resolve({ ok: true, issueId: 'i9' })),
  acceptWith: vi.fn(() => Promise.resolve({ ok: true, issueId: 'i9' })),
  linkSuggestion: vi.fn(() => Promise.resolve({ ok: true, issueId: 'i1' })),
  dismissSuggestion: vi.fn(),
}));
vi.mock('../detections/store', () => ({
  useDetections: <T,>(sel: (s: unknown) => T) =>
    sel({ review: { detections: h.detections, passThreshold: {} } }),
}));
vi.mock('../detections/createFromLabel', () => ({
  createClassFromLabel: vi.fn(() => Promise.resolve(null)),
}));

const { FindingsPanel } = await import('./FindingsPanel');
const { acceptSuggestion, dismissSuggestion } = await import('./actions');

const draft = (id: string, over: Record<string, unknown> = {}): Detection =>
  ({
    id,
    pass: 'ai-1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p1' },
    size: [4000, 3000],
    geom: { type: 'box', box: [0, 0, 10, 10] },
    classId: 'crack',
    severity: 3,
    uncertain: false,
    note: '',
    status: 'draft',
    confidence: 0.9,
    origin: { kind: 'ai', model: 'm', promptVersion: '1' },
    ...over,
  }) as unknown as Detection;

const detectorOrigin = {
  kind: 'model',
  producer: 'yolo',
  detector: { id: 'rust', version: 1, modelSha256: 'a'.repeat(64), threshold: 0.5 },
};

const you: FindingRow = {
  kind: 'you',
  key: 'issue:i1',
  issueId: 'i1',
  code: 'F01',
  title: 'Crack at the weld',
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  selected: false,
};
const ai = (id: string): FindingRow => ({
  kind: 'ai',
  key: `det:${id}`,
  detectionId: id,
  classId: 'crack',
  label: undefined,
  severity: 3,
  uncertain: false,
  confidence: 0.9,
  unscored: false,
  selected: false,
});
const issues = [
  {
    id: 'i1',
    code: 'F01',
    title: 'Crack at the weld',
    classId: 'crack',
    severity: 2,
    severityModelId: 'sev',
    sightings: [{ on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box' } }],
  },
] as unknown as Issue[];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  h.detections = [draft('d1')];
  annotateUi.setState({ imageTool: 'select' });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const render = async (over: Partial<Parameters<typeof FindingsPanel>[0]> = {}) => {
  const props = {
    projectId: 'p1',
    rows: [you, ai('d1')],
    issues,
    leftToReview: 3,
    readOnly: false,
    onSelectRow: vi.fn(),
    onNextToReview: vi.fn(),
    ...over,
  };
  await act(async () => {
    root.render(<FindingsPanel {...props} />);
    await Promise.resolve();
  });
  return props;
};
const byId = (id: string, within: ParentNode = host) =>
  within.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="inspect-row"]')];
const row = (key: string) => {
  const r = host.querySelector<HTMLElement>(`[data-testid="inspect-row"][data-key="${key}"]`);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('FindingsPanel', () => {
  it('lists yours and the AI suggestions in one list with their chips', async () => {
    await render();
    expect(host.textContent).toContain('Findings on this photo');
    expect(rows().map((r) => r.dataset.kind)).toEqual(['you', 'ai']);
    expect(row('issue:i1').textContent).toContain('YOU');
    expect(row('det:d1').textContent).toContain('AI 90%');
    expect(byId('inspect-accept', row('issue:i1'))).toBeNull();
  });

  it('shows the score badge for a detector draft', async () => {
    h.detections = [draft('d1', { origin: detectorOrigin })];
    await render();
    expect(byId('det-vlm-score', row('det:d1'))).not.toBeNull();
    expect(row('det:d1').textContent).not.toContain('AI 90%');
  });

  it('selects a row on click', async () => {
    const p = await render();
    await click(row('det:d1').querySelector('.inspect-row-head'));
    expect(p.onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ key: 'det:d1' }));
  });

  it('accepts with one click when the draft is complete', async () => {
    const p = await render();
    await click(byId('inspect-accept', row('det:d1')));
    expect(acceptSuggestion).toHaveBeenCalledWith('p1', 'd1');
    expect(byId('inspect-change-picker')).toBeNull();
    expect(p.onSelectRow).not.toHaveBeenCalled();
  });

  it('opens the picker when accept needs a class, then accepts with it', async () => {
    vi.mocked(acceptSuggestion).mockResolvedValueOnce({ ok: false, needs: 'picker' });
    await render();
    await click(byId('inspect-accept', row('det:d1')));
    expect(byId('inspect-change-picker', row('det:d1'))).not.toBeNull();
  });

  it('shows an accept refusal on the row', async () => {
    vi.mocked(acceptSuggestion).mockResolvedValueOnce({ ok: false, error: 'Disk full' });
    await render();
    await click(byId('inspect-accept', row('det:d1')));
    expect(row('det:d1').querySelector('[role="alert"]')?.textContent).toBe('Disk full');
  });

  it('disables the actions while an accept is pending', async () => {
    let finish: (v: { ok: true; issueId: string }) => void = () => undefined;
    vi.mocked(acceptSuggestion).mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await render();
    await click(byId('inspect-accept', row('det:d1')));
    const accept = byId('inspect-accept', row('det:d1')) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect((byId('inspect-dismiss', row('det:d1')) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish({ ok: true, issueId: 'i9' });
      await Promise.resolve();
    });
    expect(accept.disabled).toBe(false);
  });

  it('opens the picker from Change', async () => {
    await render();
    await click(byId('inspect-change', row('det:d1')));
    expect(byId('inspect-change-picker', row('det:d1'))).not.toBeNull();
  });

  it('asks why for a detector draft and dismisses others at once', async () => {
    h.detections = [draft('d1'), draft('d2', { origin: detectorOrigin, confidence: 0.7 })];
    await render({ rows: [ai('d1'), ai('d2')] });
    await click(byId('inspect-dismiss', row('det:d1')));
    expect(dismissSuggestion).toHaveBeenCalledWith('d1');
    await click(byId('inspect-dismiss', row('det:d2')));
    expect(dismissSuggestion).toHaveBeenCalledTimes(1);
    expect(byId('inspect-dismiss', row('det:d2'))?.getAttribute('aria-expanded')).toBe('true');
  });

  it('links to an existing finding from the picker', async () => {
    const { linkSuggestion } = await import('./actions');
    await render();
    await click(byId('inspect-change', row('det:d1')));
    await click(byId('inspect-change-same'));
    await click(host.querySelector<HTMLElement>('[role="option"]'));
    expect(linkSuggestion).toHaveBeenCalledWith('d1', 'i1');
    expect(byId('inspect-change-picker')).toBeNull();
  });

  it('hides the actions in a read-only package', async () => {
    await render({ readOnly: true });
    expect(byId('inspect-accept')).toBeNull();
    expect(byId('inspect-change')).toBeNull();
    expect(byId('inspect-dismiss')).toBeNull();
    expect(byId('inspect-draw')).toBeNull();
    expect(host.textContent).toContain('This package is read only.');
    expect(byId('inspect-next-review')).not.toBeNull();
  });

  it('starts the box tool from Draw a finding', async () => {
    await render();
    await click(byId('inspect-draw'));
    expect(annotateUi.getState().imageTool).toBe('box');
  });

  it('says how many photos are left and goes to the next one', async () => {
    const p = await render();
    expect(host.textContent).toContain('3 photos still have AI suggestions to check');
    await click(byId('inspect-next-review'));
    expect(p.onNextToReview).toHaveBeenCalledTimes(1);
  });

  it('says so when the photo has no findings', async () => {
    await render({ rows: [] });
    expect(host.textContent).toContain('No findings on this photo yet.');
  });
});
