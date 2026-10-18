// @vitest-environment jsdom
import type { CaptureLineUp, LineUpMeasure } from '@aio/schema';
import { captureIndex, createWorkspace, type Workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SplitModel } from '../workspace/SplitPanes';
import { compareLineUpApp, createCompareLineUp } from './compareLineUpStore';
import { CompareLineUp } from './CompareLineUp';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore, lineUpApp, type LineUpDeps, type LineUpStore } from './lineUpStore';
import { forgetMeasures } from './lineUpWatch';
import { fitOf, lineUpManifest, measureOf } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

function splitOf(workspace: StoreApi<Workspace>, twin = true): SplitModel {
  const manifest = workspace.getState().project?.manifest;
  const index = manifest ? captureIndex(manifest) : null;
  return {
    options: ['map', '3d'],
    sides: twin
      ? { left: 'map', right: 'map', leftCapture: 'd1', rightCapture: 'd2' }
      : { left: '3d', right: 'map' },
    reports: [],
    index,
    dates: { captures: ['d1', 'd2'] },
    set: () => undefined,
  };
}

async function show(
  answer: LineUpMeasure | { error: string },
  opts: { twin?: boolean; lineUps?: Record<string, CaptureLineUp> } = {},
) {
  const workspace = createWorkspace();
  workspace.getState().openProject({
    id: 'p',
    root: 'C:/p',
    manifest: lineUpManifest(opts.lineUps ? { lineUps: opts.lineUps } : {}),
  });
  const measure = vi.fn<LineUpDeps['measure']>(() => Promise.resolve(answer));
  const store = createCompareLineUp({ measure, workspace });
  compareLineUpApp.setState({ store, workspace });
  root = createRoot(host);
  act(() => root?.render(<CompareLineUp split={splitOf(workspace, opts.twin ?? true)} />));
  await flush();
  return { measure, store, workspace };
}

describe('CompareLineUp', () => {
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    compareLineUpApp.setState({ store: null, workspace: null });
    lineUpApp.setState({ store: null, preview: null, extents: null });
    forgetMeasures();
  });

  it('aligned shows Lined up', async () => {
    await show(measureOf({ verdict: 'aligned', totalM: 0.03 }));
    expect(byId('compare-lineup')?.dataset.status).toBe('lined');
    expect(byId('compare-lineup-label')?.textContent).toBe('Lined up');
    expect(byId('compare-lineup-action')).toBeNull();
  });

  it('ok shows the distance and Line up', async () => {
    const { measure } = await show(measureOf({ totalM: 2.04 }));
    expect(measure.mock.calls[0]?.slice(0, 2)).toEqual(['d1', 'd2']);
    expect(byId('compare-lineup-label')?.textContent).toBe('2.04 m off');
    expect(byId('compare-lineup-action')?.textContent).toBe('Line up');
  });

  it('ok with a fit shows its largest move', async () => {
    await show(measureOf({ totalM: 2.04, fit: fitOf({ verdict: 'ok', maxMoveM: 2.6 }) }));
    expect(byId('compare-lineup-label')?.textContent).toBe('2.60 m off');
  });

  it('Line up opens the dialog with both dates', async () => {
    const { workspace } = await show(measureOf());
    const step = createLineUpStore({
      workspace,
      measure: () => Promise.resolve(measureOf()),
      saveCapture: () => Promise.resolve(null),
      pinCaptures: () => Promise.resolve(null),
      hints: () => ({}),
      issues: () => [],
      measurements: () => [],
      memory: createLineUpMemory(null),
      now: () => '2026-10-18T10:00:00.000Z',
    });
    lineUpApp.setState({ store: step });
    act(() => {
      byId('compare-lineup-action')?.click();
    });
    await flush();
    // both dates, the left-hand one kept; the person can still switch
    expect(step.getState().dialog).toMatchObject({ a: 'd1', b: 'd2', keep: 'd1' });
    act(() => {
      step.getState().choose('d2');
    });
    expect(step.getState().dialog?.keep).toBe('d2');
    // other ways in leave the choice to the person
    step.getState().close();
    await act(() => step.getState().open('d1', 'd2'));
    expect(step.getState().dialog?.keep).toBeNull();
  });

  it('a failed measurement offers to measure again', async () => {
    const { measure } = await show({ error: 'The job failed.' });
    expect(byId('compare-lineup')?.dataset.status).toBe('cannot');
    measure.mockResolvedValueOnce(measureOf());
    act(() => {
      byId('compare-lineup-chip')?.click();
    });
    act(() => {
      byId('compare-lineup-retry')?.click();
    });
    await flush();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(byId('compare-lineup')?.dataset.status).toBe('off');
  });

  it("range shows Can't line up with the reason", async () => {
    await show(measureOf({ fit: fitOf({ verdict: 'range', maxMoveM: 9 }) }));
    expect(byId('compare-lineup')?.dataset.status).toBe('cannot');
    expect(byId('compare-lineup-label')?.textContent).toBe("Can't line up");
    const chip = byId('compare-lineup-chip');
    expect(chip?.getAttribute('aria-label')).toBe("Line-up of the two dates: Can't line up");
    act(() => {
      chip?.click();
    });
    expect(byId('compare-lineup-details')?.textContent).toContain('These dates cannot be lined up');
  });

  it('shows the saved line-up, its turn and clouds in the details', async () => {
    const lined: CaptureLineUp = {
      eastM: 2,
      northM: 0,
      with: 'd1',
      at: '2026-10-18T10:00:00.000Z',
    };
    const workspace = createWorkspace();
    const manifest = lineUpManifest({ lineUps: { d2: lined } });
    const turned = {
      ...manifest,
      captures: manifest.captures.map((c) =>
        c.id === 'd2'
          ? {
              ...c,
              lineUpTurn: { rotationDeg: 0.11, scale: 0.9982, pivotE: 500100, pivotN: 4000100 },
            }
          : c,
      ),
    };
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: turned });
    const remove = vi.fn<LineUpStore['remove']>(() => Promise.resolve());
    lineUpApp.setState({
      store: createStore(() => ({ remove, notice: null })) as unknown as StoreApi<LineUpStore>,
    });
    const store = createCompareLineUp({
      measure: () => Promise.resolve(measureOf({ verdict: 'aligned', totalM: 0.02 })),
      workspace,
    });
    compareLineUpApp.setState({ store, workspace });
    root = createRoot(host);
    act(() => root?.render(<CompareLineUp split={splitOf(workspace)} />));
    await flush();
    act(() => {
      byId('compare-lineup-chip')?.click();
    });
    const details = byId('compare-lineup-details')?.textContent ?? '';
    expect(details).toContain('Survey 13 April 2026 lined up with Survey 2 March 2026');
    expect(details).toContain('2.00 m east');
    expect(details).toContain('turned 0.11°, scaled -0.18%');
    expect(details).toContain("Point clouds move but don't turn yet.");
    act(() => {
      byId('compare-lineup-remove-d2')?.click();
    });
    expect(remove).toHaveBeenCalledWith('d2');
  });

  it('renders nothing without a twin', async () => {
    const { measure } = await show(measureOf(), { twin: false });
    expect(byId('compare-lineup')).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });
});
