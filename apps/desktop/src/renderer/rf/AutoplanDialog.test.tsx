// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AntennaUnit, IpcResponse, RfCatalogueEntry } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennasFile, sectorsFile, unit } from './__fixtures__/rfData';
import { AutoplanDialog } from './AutoplanDialog';
import {
  applyAutoplan,
  autoplanStore,
  cancelAutoplan,
  confirmSend,
  openAntennaReviewOrFallback,
  resetAutoplan,
  switchSource,
  type AutoplanState,
} from './autoplan/autoplanStore';
import { buildProposal, type Proposal } from './autoplan/proposal';
import { resetRf, rfStore } from './rfStore';

vi.mock('../shell', () => ({ bridge: { call: vi.fn(() => Promise.resolve({ ok: false })) } }));

vi.mock('./autoplan/autoplanStore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyAutoplan: vi.fn(() => Promise.resolve(null)),
    cancelAutoplan: vi.fn(),
    confirmSend: vi.fn(() => Promise.resolve()),
    switchSource: vi.fn(() => Promise.resolve()),
    openAntennaReviewOrFallback: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOGUE = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), '../../packages/rf/catalogue/generic.json'), 'utf8'),
  ) as { entries: RfCatalogueEntry[] }
).entries;

let host: HTMLDivElement;
let root: Root | undefined;
const byTest = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = byTest(id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};
const click = (el: HTMLElement) => {
  act(() => {
    el.click();
  });
};
const buttonNamed = (scope: HTMLElement, text: RegExp): HTMLButtonElement => {
  const b = [...scope.querySelectorAll('button')].find((x) => text.test(x.textContent));
  if (!b) throw new Error(`no button ${String(text)}`);
  return b;
};

/** A panel with the given face; AAU-like when 0.5 m wide and 0.2 m deep. */
function panel(id: string, az: number, name: string, face: 'aau' | 'panel' = 'aau'): AntennaUnit {
  const u = unit(id, az, { name });
  return {
    ...u,
    widthM: { ...u.widthM, value: face === 'aau' ? 0.5 : 0.3 },
    depthM: { ...u.depthM, value: face === 'aau' ? 0.2 : 0.1 },
  };
}

const UNITS = (): AntennaUnit[] => [
  panel('ant-u1', 0, 'Panel A'),
  panel('ant-u2', 120, 'Panel B'),
  panel('ant-u3', 240, 'Panel C', 'panel'),
  unit('ant-u4', 300, { name: 'Panel D', status: 'draft' }),
];

function seed(units: AntennaUnit[], settings = sectorsFile([], [])): void {
  rfStore.setState({
    status: 'ready',
    projectId: 'p1',
    antennas: antennasFile(units),
    sectors: settings,
    catalogue: CATALOGUE.map((entry) => ({ origin: 'builtin' as const, entry })),
  });
}

function proposalOf(units: AntennaUnit[]): Proposal {
  const s = rfStore.getState();
  return buildProposal({
    units,
    file: s.sectors,
    catalogue: s.catalogue.map((c) => c.entry),
    picks: new Map(),
  });
}

function renderWith(state: Partial<AutoplanState>): void {
  act(() => {
    autoplanStore.setState(state);
  });
  root = createRoot(host);
  act(() => {
    root?.render(<AutoplanDialog />);
  });
}

const CLOUD_PREVIEW: IpcResponse<'ai:rfPlanPreview'> = {
  ok: true,
  provider: 'anthropic',
  model: 'model-x',
  cloud: true,
  photosAllowed: true,
  crops: [{ unitId: 'ant-u1', path: 'telecom/crops/ant-u1.jpg' }],
  estimate: { inputTokens: 1200, costUsd: 0.004 },
  token: 'tok',
};

const reviewState = (units = UNITS()): Partial<AutoplanState> => ({
  phase: 'review',
  source: 'rules',
  projectId: 'p1',
  aiAvailable: true,
  proposal: proposalOf(units),
});

beforeEach(() => {
  resetRf();
  resetAutoplan();
  vi.clearAllMocks();
  seed(UNITS());
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

describe('AutoplanDialog', () => {
  it('renders nothing while Auto-plan is idle', () => {
    renderWith({ phase: 'idle' });
    expect(byTest('rf-autoplan')).toBeNull();
  });

  it('renders into a portal under <body>, outside its React parent', () => {
    renderWith(reviewState());
    const dlg = must('rf-autoplan');
    expect(host.contains(dlg)).toBe(false);
    expect(document.body.contains(dlg)).toBe(true);
    expect(dlg.getAttribute('role')).toBe('dialog');
  });

  it('shows one row per planned unit with sector, equipment, band, reason and confidence', () => {
    renderWith(reviewState());
    const row = must('rf-autoplan-row-ant-u1');
    expect(row.textContent).toContain('S1');
    expect(row.textContent).toContain('Panel A');
    expect(row.textContent).toContain('AAU 64T64R 3.5 GHz 200 W');
    expect(row.textContent).toContain('n78 · NR · 100 MHz');
    expect(row.textContent).toMatch(/generic · unverified/);
    expect(row.textContent).toContain('0.50 m × 0.20 m deep face: AAU');
    expect(row.textContent).toContain('medium');
    // the panel face gets the panel and radio on B3
    const r3 = must('rf-autoplan-row-ant-u3');
    expect(r3.textContent).toContain('B3 · LTE · 20 MHz');
    expect(r3.textContent).toContain('+');
    expect(byTest('rf-autoplan-row-ant-u4')).toBeNull();
  });

  it('marks low confidence rows amber and kept rows as kept', () => {
    seed(
      UNITS(),
      sectorsFile(
        [{ id: 'S1', antennaIds: ['ant-u1', 'ant-u2', 'ant-u3'] }],
        [
          {
            antennaId: 'ant-u2',
            active: true,
            equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
            carriers: [{ id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 80, feederLossDb: 0 }],
          },
        ],
      ),
    );
    const state = reviewState();
    const p = state.proposal;
    if (!p) throw new Error('no proposal');
    const rows = p.rows.map((r) =>
      r.unitId === 'ant-u1'
        ? { ...r, picks: r.picks.map((x) => ({ ...x, confidence: 'low' as const })) }
        : r,
    );
    renderWith({ ...state, proposal: { ...p, rows } });
    expect(must('rf-autoplan-row-ant-u1').dataset.confidence).toBe('low');
    const kept = must('rf-autoplan-row-ant-u2');
    expect(kept.dataset.confidence).toBe('kept');
    expect(kept.textContent).toContain('kept');
    // the person's equipment shows, from the settings, not from a pick
    expect(kept.textContent).toContain('AAU 64T64R 3.5 GHz 200 W');
    // its own carrier is written unchanged, so it shows from the settings, marked kept
    expect(kept.textContent).toContain('kept: n78 · NR · 80 MHz');
    expect(kept.textContent).not.toContain('n78 · NR · 100 MHz');
  });

  it('shows the row note as a warning', () => {
    const state = reviewState();
    const p = state.proposal;
    if (!p) throw new Error('no proposal');
    const rows = p.rows.map((r) =>
      r.unitId === 'ant-u1' ? { ...r, note: 'Set the band by hand' } : r,
    );
    renderWith({ ...state, proposal: { ...p, rows } });
    const note = must('rf-autoplan-row-ant-u1').querySelector('.rf-autoplan-note');
    expect(note?.textContent).toBe('Set the band by hand');
  });

  it('lists drafts as left out with a review link', () => {
    renderWith(reviewState());
    const left = must('rf-autoplan-left-ant-u4');
    expect(left.textContent).toContain('Panel D');
    expect(left.textContent).toContain('Not reviewed yet');
    click(buttonNamed(left, /Review/));
    expect(openAntennaReviewOrFallback).toHaveBeenCalledTimes(1);
    // Auto-plan closes first, so the inventory is not under the dialog
    expect(vi.mocked(cancelAutoplan).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(openAntennaReviewOrFallback).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('lists a unit with no bearing as left out', () => {
    const units = [...UNITS(), unit('ant-u5', 10, { name: 'Panel E', convergenceDeg: null })];
    seed(units);
    renderWith(reviewState(units));
    expect(must('rf-autoplan-left-ant-u5').textContent).toMatch(/bearing/i);
  });

  it('blocked-review shows "Review antennas first" and no apply buttons', () => {
    renderWith({ phase: 'blocked-review', source: 'rules', projectId: 'p1' });
    const dlg = must('rf-autoplan');
    expect(dlg.textContent).toContain('Review antennas first');
    expect(byTest('rf-autoplan-apply')).toBeNull();
    expect(byTest('rf-autoplan-apply-run')).toBeNull();
    click(must('rf-autoplan-cancel'));
    expect(cancelAutoplan).toHaveBeenCalledTimes(1);
    expect(openAntennaReviewOrFallback).not.toHaveBeenCalled();
    // the review opens and Auto-plan closes
    click(buttonNamed(dlg, /Review antennas/));
    expect(openAntennaReviewOrFallback).toHaveBeenCalledTimes(1);
    expect(cancelAutoplan).toHaveBeenCalledTimes(2);
  });

  it('Apply & run calls applyAutoplan(true); Apply only calls applyAutoplan(false)', async () => {
    renderWith(reviewState());
    expect(must('rf-autoplan-apply-run').textContent).toContain('Apply & run coverage');
    await act(async () => {
      must('rf-autoplan-apply-run').click();
      await Promise.resolve();
    });
    expect(applyAutoplan).toHaveBeenLastCalledWith(true);
    await act(async () => {
      must('rf-autoplan-apply').click();
      await Promise.resolve();
    });
    expect(applyAutoplan).toHaveBeenLastCalledWith(false);
    expect(applyAutoplan).toHaveBeenCalledTimes(2);
    click(must('rf-autoplan-cancel'));
    expect(cancelAutoplan).toHaveBeenCalledTimes(1);
  });

  it('says so when the plan is applied but the run does not start', async () => {
    vi.mocked(applyAutoplan).mockImplementationOnce(() => {
      // the store writes the plan and closes Auto-plan before it starts the run
      autoplanStore.setState({ phase: 'idle', proposal: null });
      return Promise.resolve({ ok: false, code: 'refused' });
    });
    renderWith(reviewState());
    await act(async () => {
      must('rf-autoplan-apply-run').click();
      await Promise.resolve();
    });
    const alert = must('rf-autoplan').querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/applied/i);
    click(must('rf-autoplan-cancel'));
    expect(byTest('rf-autoplan')).toBeNull();
  });

  it('closes after Apply & run when the run starts', async () => {
    vi.mocked(applyAutoplan).mockImplementationOnce(() => {
      autoplanStore.setState({ phase: 'idle', proposal: null });
      return Promise.resolve({ ok: true, jobId: 'j', runId: 'r' });
    });
    renderWith(reviewState());
    await act(async () => {
      must('rf-autoplan-apply-run').click();
      await Promise.resolve();
    });
    expect(byTest('rf-autoplan')).toBeNull();
  });

  it('the source switch offers Rules only and disables the provider when unavailable', () => {
    renderWith({ ...reviewState(), source: 'rules', aiAvailable: false });
    const seg = must('rf-autoplan-source');
    const [ai, rules] = [...seg.querySelectorAll('button')];
    expect(rules?.textContent).toBe('Rules only');
    expect(rules?.getAttribute('aria-pressed')).toBe('true');
    expect(ai?.disabled).toBe(true);
    if (ai) click(ai);
    expect(switchSource).not.toHaveBeenCalled();
  });

  it('the source switch plans again from the other source', () => {
    renderWith({ ...reviewState(), source: 'ai', aiAvailable: true });
    const seg = must('rf-autoplan-source');
    const [ai, rules] = [...seg.querySelectorAll('button')];
    expect(ai?.getAttribute('aria-pressed')).toBe('true');
    if (rules) click(rules);
    expect(switchSource).toHaveBeenCalledWith('rules');
  });

  it('thinking shows progress and Cancel', () => {
    renderWith({ phase: 'thinking', source: 'ai', aiAvailable: true });
    const dlg = must('rf-autoplan');
    expect(dlg.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(byTest('rf-autoplan-apply')).toBeNull();
    click(must('rf-autoplan-cancel'));
    expect(cancelAutoplan).toHaveBeenCalledTimes(1);
  });

  it('error offers Rules only and Cancel', () => {
    renderWith({
      phase: 'error',
      source: 'ai',
      aiAvailable: true,
      error: 'The AI did not answer.',
    });
    const dlg = must('rf-autoplan');
    expect(dlg.textContent).toContain('The AI did not answer');
    click(buttonNamed(dlg, /Use Rules only/));
    expect(switchSource).toHaveBeenCalledWith('rules');
    click(must('rf-autoplan-cancel'));
    expect(cancelAutoplan).toHaveBeenCalledTimes(1);
  });

  it('error shows a provider message it does not know as it came', () => {
    renderWith({ phase: 'error', source: 'ai', aiAvailable: true, error: 'rate limited' });
    expect(must('rf-autoplan').textContent).toContain('rate limited');
  });

  it('preview shows the send dialog; Send confirms with the photo consent, Cancel cancels', () => {
    const preview = CLOUD_PREVIEW;
    renderWith({ phase: 'preview', source: 'ai', aiAvailable: true, preview });
    const dlg = must('rf-autoplan');
    expect(dlg.textContent).toContain('model-x');
    expect(dlg.textContent).toMatch(/never sends the project or site name/i);
    expect(dlg.querySelector('img')?.getAttribute('alt')).toBe('Panel A');
    click(must('rf-autoplan-send'));
    expect(confirmSend).toHaveBeenCalledWith(true);
    click(buttonNamed(dlg, /Cancel/));
    expect(cancelAutoplan).toHaveBeenCalledTimes(1);
  });

  it("a new Auto-plan never shows the last one's cost, photos or provider", () => {
    renderWith({ phase: 'preview', source: 'ai', aiAvailable: true, preview: CLOUD_PREVIEW });
    expect(must('rf-autoplan').textContent).toContain('Anthropic');
    act(() => {
      autoplanStore.setState({ phase: 'idle', preview: null });
    });
    expect(byTest('rf-autoplan')).toBeNull();
    // a local model this time: no send preview reaches the dialog
    act(() => {
      autoplanStore.setState({ ...reviewState(), source: 'ai', provider: 'local', cloud: false });
    });
    const dlg = must('rf-autoplan');
    expect(dlg.textContent).not.toMatch(/photo/i);
    expect(dlg.textContent).not.toContain('Anthropic');
    expect(dlg.textContent).toContain('runs on this computer');
  });

  it('names the provider from the store when no preview was shown', () => {
    renderWith({ ...reviewState(), source: 'ai', provider: 'anthropic', cloud: true });
    const ai = must('rf-autoplan-source-ai');
    expect(ai.textContent).toBe('Anthropic');
    expect(must('rf-autoplan').textContent).not.toMatch(/photo/i);
  });

  it('preview waits without buttons until the preview has come back', () => {
    renderWith({ phase: 'preview', source: 'ai', aiAvailable: true, preview: null });
    expect(must('rf-autoplan').querySelector('[role="progressbar"]')).not.toBeNull();
    expect(byTest('rf-autoplan-send')).toBeNull();
  });

  it('Escape cancels', () => {
    renderWith(reviewState());
    act(() => {
      must('rf-autoplan').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(cancelAutoplan).toHaveBeenCalled();
  });
});
