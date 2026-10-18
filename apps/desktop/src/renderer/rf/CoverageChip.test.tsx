// @vitest-environment jsdom
import type { AntennaUnit, RfRun } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaStore } from '../telecom/antennaStore';
import { workbench } from '../workspace/workbench/workbenchStore';
import { antennasFile, unit } from './__fixtures__/rfData';
import {
  autoplanStore,
  openAntennaReviewOrFallback,
  resetAutoplan,
  startAutoplan,
} from './autoplan/autoplanStore';
import { rfLayer } from './coverageDisplay';
import { CoverageChip, NARROW_CHIP_PX } from './CoverageChip';
import { resetRf, rfStore, type RfClassStat, type RfState } from './rfStore';
import { startRfRun } from './rfTab';

vi.mock('./autoplan/autoplanStore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, startAutoplan: vi.fn(), openAntennaReviewOrFallback: vi.fn() };
});
vi.mock('./rfTab', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    startRfRun: vi.fn(() => Promise.resolve({ ok: true, jobId: 'job-1', runId: 'rf-1' })),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
};

const STATS: RfClassStat[] = [
  { cls: 'excellent', areaM2: 0, share: 0 },
  { cls: 'good', areaM2: 4, share: 0.04 },
  { cls: 'fair', areaM2: 13, share: 0.13 },
  { cls: 'poor', areaM2: 50, share: 0.5 },
  { cls: 'none', areaM2: 33, share: 0.33 },
];
// 08:17 local time, as the legend shows a run's time of day
const RUN = { runId: 'rf-1', createdAt: new Date(2026, 9, 18, 8, 17).toISOString() } as RfRun;
const planned = {
  schema: 'aio.rf-sectors/1',
  sectors: [
    { id: 'sec-s1', name: 'S1', antennaIds: ['ant-a'] },
    { id: 'sec-s2', name: 'S2', antennaIds: ['ant-b'] },
    { id: 'sec-s3', name: 'S3', antennaIds: ['ant-c'] },
  ],
  antennas: ['ant-a', 'ant-b', 'ant-c'].map((antennaId) => ({
    antennaId,
    active: true,
    equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
    carriers: [{ id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 100, feederLossDb: 0 }],
  })),
} as unknown as RfState['sectors'];
const empty = { ...planned, sectors: [], antennas: [] } as RfState['sectors'];

const site3 = (): AntennaUnit[] => [unit('ant-a', 0), unit('ant-b', 120), unit('ant-c', 240)];

let host: HTMLDivElement;
let root: Root;
/** The width the chip's row reads (0: not laid out, as jsdom). */
let rowWidth = 0;

function seed(units: AntennaUnit[] | null, rf: Partial<RfState> = {}): void {
  rfStore.setState({ projectId: 'p1', sectors: empty, ...rf });
  antennaStore.setState({
    projectId: 'p1',
    root: 'C:/proj',
    status: 'ready',
    file: units ? antennasFile(units) : null,
  });
}
function render(): void {
  act(() => {
    root.render(<CoverageChip />);
  });
}
const chip = () => host.querySelector<HTMLElement>('[data-testid="rf-chip"]');
/** Text with runs of white space as one space. */
const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  const el = byId(id);
  if (!el) throw new Error(`no ${id}`);
  act(() => {
    el.click();
  });
};

beforeEach(() => {
  rowWidth = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('rf-chip-row') ? rowWidth : 0;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  workspace.getState().openProject({
    id: 'p1',
    root: 'C:/proj',
    manifest: { schema: 'aio.project/1', name: 'P', layers: [] } as never,
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.mocked(startAutoplan).mockClear();
  vi.mocked(openAntennaReviewOrFallback).mockClear();
  vi.mocked(startRfRun).mockClear();
  resetRf();
  resetAutoplan();
  antennaStore.setState({ projectId: null, file: null, status: 'idle' });
  rfLayer.setState({ visible: true });
  workspace.getState().closeProject();
  workbench.getState().close('rf');
});

describe('the Coverage chip', () => {
  it('is hidden without antennas', () => {
    seed(null);
    render();
    expect(chip()).toBeNull();
    seed([]);
    render();
    expect(chip()).toBeNull();
  });

  it('not-planned shows the count and Auto-plan', () => {
    seed(site3());
    render();
    expect(chip()?.dataset.state).toBe('not-planned');
    expect(text(chip())).toContain('Coverage · 3 antennas · not planned');
    click('rf-chip-autoplan');
    expect(startAutoplan).toHaveBeenCalled();
  });

  it('review-first shows Review antennas', () => {
    const drafts = site3().map((u) => ({ ...u, status: 'draft' as const }));
    seed([...drafts, unit('ant-d', 300, { status: 'draft' })]);
    render();
    expect(chip()?.dataset.state).toBe('review-first');
    expect(text(chip())).toContain('Coverage · 4 antennas · review first');
    expect(text(byId('rf-chip-review'))).toContain('Review antennas');
    click('rf-chip-review');
    expect(openAntennaReviewOrFallback).toHaveBeenCalled();
    expect(startAutoplan).not.toHaveBeenCalled();
  });

  it('ready shows the sectors and Run, which starts a run in the open project', () => {
    seed(site3(), { sectors: planned });
    render();
    expect(chip()?.dataset.state).toBe('ready');
    expect(text(chip())).toContain('Coverage · 3 sectors · ready');
    click('rf-chip-run');
    expect(startRfRun).toHaveBeenCalledWith('C:/proj');
  });

  it('planning and running say so, with no action buttons', () => {
    seed(site3());
    act(() => {
      autoplanStore.setState({ phase: 'thinking' });
    });
    render();
    expect(chip()?.dataset.state).toBe('planning');
    expect(text(chip())).toContain('Coverage · planning…');
    act(() => {
      rfStore.setState({ running: true });
    });
    expect(chip()?.dataset.state).toBe('running');
    expect(text(chip())).toContain('Coverage · running…');
    expect(
      chip()?.querySelectorAll('[data-testid^="rf-chip-"]:not([data-testid="rf-chip-open"])'),
    ).toHaveLength(0);
  });

  it('result shows the RSRP share and toggles the layer', () => {
    seed(site3(), {
      sectors: planned,
      runs: [RUN],
      selectedRunId: RUN.runId,
      classStats: STATS,
      view: 'rsrp',
    });
    render();
    expect(chip()?.dataset.state).toBe('result');
    expect(text(chip())).toContain('Coverage · RSRP · 17% fair or better · 08:17');
    const layer = byId('rf-chip-layer');
    expect(layer?.getAttribute('aria-pressed')).toBe('true');
    click('rf-chip-layer');
    // the same state as the Display bench's Coverage eye
    expect(rfLayer.getState().visible).toBe(false);
    expect(byId('rf-chip-layer')?.getAttribute('aria-pressed')).toBe('false');
    click('rf-chip-replan');
    expect(startAutoplan).toHaveBeenCalled();
  });

  it('result names the view instead of the share for best server and overlap', () => {
    seed(site3(), {
      sectors: planned,
      runs: [RUN],
      selectedRunId: RUN.runId,
      classStats: STATS,
      view: 'bestServer',
    });
    render();
    expect(text(chip())).toContain('Coverage · Best server · 08:17');
    expect(text(chip())).not.toContain('fair or better');
  });

  it('clicking the chip body opens the Coverage tab pinned', () => {
    seed(site3());
    render();
    click('rf-chip-open');
    const tab = workbench.getState().tabs.find((t) => t.id === 'rf');
    expect(tab?.pinned).toBe(true);
    expect(workbench.getState().front).toBe('rf');
  });

  it('narrow layout keeps the dot, Coverage and the buttons only', () => {
    seed(site3());
    // the stage beside the panels in a 1100 px window
    rowWidth = NARROW_CHIP_PX - 1;
    render();
    expect(chip()?.querySelector('.rf-chip-dot')).not.toBeNull();
    expect(chip()?.querySelector('.rf-chip-desc')).toBeNull();
    expect(text(chip())).toContain('Coverage');
    expect(byId('rf-chip-autoplan')).not.toBeNull();
    // the full text keeps its words for a screen reader
    expect(byId('rf-chip-open')?.getAttribute('aria-label')).toBe(
      'Coverage · 3 antennas · not planned',
    );
    // wide enough: the words come back
    act(() => {
      root.unmount();
    });
    root = createRoot(host);
    rowWidth = NARROW_CHIP_PX;
    render();
    expect(chip()?.querySelector('.rf-chip-desc')).not.toBeNull();
  });
});
