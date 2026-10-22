// @vitest-environment jsdom
import {
  VLM_DETECTOR_SCHEMA,
  type DetectorWhere,
  type IpcResponse,
  type VlmDetector,
} from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  answers: new Map<string, (req: unknown) => unknown>(),
  calls: [] as { channel: string; req: unknown }[],
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
  useShell: (sel: (s: object) => unknown) => sel({ settings: { dataRoot: 'D:\\data' } }),
}));

import { analyticsPack } from '../../analyticsPack';
import { DetectorLibrary, hitRate } from './DetectorLibrary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = IpcResponse<'detectors:list'>['items'][number];
type Stats = IpcResponse<'ledger:stats'>;

const SHA = 'a'.repeat(64);
const det = (id: string, over: Partial<VlmDetector> = {}): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version: 1,
  classId: 'defect',
  assetTypes: ['roof'],
  looksLike: 'a dark patch',
  ignore: '',
  question: 'Is this a defect?',
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
const ALL: Item[] = [
  item('shipped', det('rust', { source: 'shipped' })),
  item('library', det('chimney')),
  item('project', det('crack')),
];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  h.answers.clear();
  h.calls.length = 0;
  analyticsPack.setState(analyticsPack.getInitialState());
  workspace.setState({ project: null });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

function installPack() {
  analyticsPack.setState({
    status: {
      installed: { version: '0.23.0', dir: 'D:\\data\\runtime\\analytics-pack-0.23.0' },
      offer: null,
      unusable: [],
    },
  });
}
function openProject() {
  workspace.setState({ project: { id: 'p1' } as OpenProject });
}

async function show(items: Item[], stats: Record<string, Stats> = {}) {
  h.answers.set('detectors:list', () => ({ items }));
  h.answers.set('ledger:stats', (req) => stats[(req as { detectorId: string }).detectorId] ?? NONE);
  root = createRoot(host);
  act(() => root?.render(<DetectorLibrary />));
  await flush();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const byText = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
const callsOf = (channel: string) => h.calls.filter((c) => c.channel === channel);

async function click(el: HTMLElement | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.click();
    await Promise.resolve();
  });
  await flush();
}

describe('hitRate', () => {
  it('is accepted over accepted plus rejected, null with no verdicts', () => {
    expect(hitRate({ accepted: 9, rejected: 3 })).toBe(0.75);
    expect(hitRate({ accepted: 0, rejected: 0 })).toBeNull();
    expect(hitRate({ accepted: 0, rejected: 4 })).toBe(0);
  });
});

describe('Settings, detector library', () => {
  it('lists shipped, library and project detectors in groups', async () => {
    installPack();
    openProject();
    await show(ALL);
    expect(callsOf('detectors:list')[0]?.req).toEqual({ projectId: 'p1' });
    expect(host.textContent).toContain('Detector library');
    const groups = [...host.querySelectorAll('[data-testid^="dl-group-"]')];
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual([
      'Shipped',
      'My library',
      'This project',
    ]);
    expect(q('dl-group-shipped')?.textContent).toContain('Detector rust');
    expect(q('dl-group-library')?.textContent).toContain('Detector chimney');
    expect(q('dl-group-project')?.textContent).toContain('Detector crack');
  });

  it('with no pack installed, shows the library and project groups only', async () => {
    openProject();
    await show(ALL);
    expect(q('dl-group-shipped')).toBeNull();
    expect(host.textContent).not.toContain('Detector rust');
    expect(q('dl-group-library')).not.toBeNull();
    expect(q('dl-group-project')).not.toBeNull();
  });

  it('with no project open, asks for the library only', async () => {
    await show([item('library', det('chimney'))]);
    expect(callsOf('detectors:list')[0]?.req).toEqual({});
    expect(q('dl-group-project')).toBeNull();
  });

  it('an experimental detector is labelled', async () => {
    await show([item('library', det('chimney', { status: 'experimental' }))]);
    const chip = q('dl-row-library-chimney')?.querySelector('.chip-status');
    expect(chip?.getAttribute('data-tone')).toBe('warn');
    expect(chip?.textContent).toBe('Experimental');
  });

  it('a model mismatch shows the warning', async () => {
    await show([item('library', det('chimney'), true), item('library', det('flue'))]);
    const warn = q('dl-mismatch-chimney');
    expect(warn).not.toBeNull();
    expect(warn?.getAttribute('title')).toBeNull();
    expect(warn?.getAttribute('aria-label')).toBe(
      'This detector was tuned on a different model, so its results may differ.',
    );
    expect(q('dl-mismatch-flue')).toBeNull();
  });

  it('shows the hit rate, misses and suggested threshold', async () => {
    await show([item('library', det('chimney'))], {
      chimney: { accepted: 9, rejected: 3, misses: 2, suggestedThreshold: 0.85 },
    });
    expect(callsOf('ledger:stats')[0]?.req).toEqual({ detectorId: 'chimney' });
    expect(q('dl-stats-chimney')?.textContent).toBe(
      '75% hit rate · 12 reviewed · 2 missed · suggested threshold 0.85',
    );
  });

  it('no reviews shows "No reviews yet"', async () => {
    await show([item('library', det('chimney'))]);
    expect(q('dl-stats-chimney')?.textContent).toBe('No reviews yet');
  });

  it('import with a conflict offers update or keep both', async () => {
    await show([]);
    const file = 'C:\\Users\\someone\\chimney.aiodet';
    h.answers.set('detectors:import', (req) =>
      (req as { onConflict?: string }).onConflict
        ? { ok: true, id: 'chimney-2' }
        : {
            ok: false,
            error: 'A detector "chimney" is already here.',
            conflict: { id: 'chimney', have: 1, incoming: 2 },
            path: file,
          },
    );
    await click(q('dl-import'));
    expect(callsOf('detectors:import')[0]?.req).toEqual({ where: 'library' });
    const conflict = q('dl-conflict');
    expect(conflict?.textContent).toContain('chimney');
    expect(byText('Update to version 2')).toBeTruthy();
    expect(byText('Keep both')).toBeTruthy();
    h.answers.set('detectors:list', () => ({
      items: [item('library', det('chimney')), item('library', det('chimney-2'))],
    }));
    await click(byText('Keep both'));
    expect(callsOf('detectors:import')[1]?.req).toEqual({
      where: 'library',
      path: file,
      onConflict: 'keep-both',
    });
    expect(q('dl-conflict')).toBeNull();
    expect(q('dl-row-library-chimney-2')).not.toBeNull();
  });

  it('a cancelled import says nothing', async () => {
    await show([]);
    h.answers.set('detectors:import', () => ({
      ok: false,
      error: 'Import cancelled.',
      cancelled: true,
    }));
    await click(q('dl-import'));
    expect(q('dl-error')).toBeNull();
  });

  it('export asks whether to leave out sample photos', async () => {
    await show([item('library', det('chimney'))]);
    h.answers.set('detectors:export', () => ({ ok: true, path: 'C:\\out\\chimney.aiodet' }));
    await click(q('dl-export-chimney'));
    expect(callsOf('detectors:export')).toHaveLength(0);
    const box = q('dl-export-panel')?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.closest('label')?.textContent).toBe(
      'Leave out sample photos (client-confidential)',
    );
    expect(box?.checked).toBe(false);
    // sample photos go into the file: a faint line says who may see it
    expect(q('dl-export-warn')?.textContent).toBe(
      'Sample photos may show client sites. Share this file only with people allowed to see them.',
    );
    act(() => box?.click());
    expect(q('dl-export-warn')).toBeNull();
    await click(q('dl-export-go'));
    expect(callsOf('detectors:export')[0]?.req).toEqual({
      where: 'library',
      id: 'chimney',
      includeSamples: false,
    });
    expect(q('dl-note')?.textContent).toContain('chimney.aiodet');
  });

  it('shipped detectors cannot be removed', async () => {
    installPack();
    await show([item('shipped', det('rust', { source: 'shipped' })), item('library', det('flue'))]);
    expect(q('dl-remove-rust')).toBeNull();
    expect(q('dl-export-rust')).not.toBeNull();
    expect(q('dl-remove-flue')).not.toBeNull();
  });

  it('remove asks first, then removes from its group', async () => {
    openProject();
    await show([item('project', det('crack'))]);
    h.answers.set('detectors:remove', () => ({ ok: true }));
    await click(q('dl-remove-crack'));
    expect(callsOf('detectors:remove')).toHaveLength(0);
    h.answers.set('detectors:list', () => ({ items: [] }));
    await click(q('dl-remove-yes-crack'));
    expect(callsOf('detectors:remove')[0]?.req).toEqual({
      where: 'project',
      projectId: 'p1',
      id: 'crack',
    });
    expect(q('dl-row-project-crack')).toBeNull();
  });

  it('clear review history asks first and calls ledger:clear', async () => {
    await show([item('library', det('chimney'))], {
      chimney: { accepted: 9, rejected: 3, misses: 2, suggestedThreshold: 0.85 },
    });
    h.answers.set('ledger:clear', () => ({ ok: true }));
    await click(q('dl-clear-chimney'));
    expect(callsOf('ledger:clear')).toHaveLength(0);
    h.answers.set('ledger:stats', () => NONE);
    await click(q('dl-clear-yes-chimney'));
    expect(callsOf('ledger:clear')[0]?.req).toEqual({ detectorId: 'chimney' });
    expect(q('dl-stats-chimney')?.textContent).toBe('No reviews yet');
    expect(q('dl-clear-chimney')).toBeNull();
  });

  it('a list read for the previous project does not land after a switch', async () => {
    openProject();
    const pending = new Map<string, (v: unknown) => void>();
    h.answers.set('ledger:stats', () => NONE);
    h.answers.set(
      'detectors:list',
      (req) => new Promise((r) => pending.set((req as { projectId?: string }).projectId ?? '', r)),
    );
    root = createRoot(host);
    act(() => root?.render(<DetectorLibrary />));
    await flush();
    pending.get('p1')?.({ items: [item('project', det('crack'))] });
    await flush();
    expect(q('dl-row-project-crack')).not.toBeNull();
    // a remove in p1 reads the list again; that read is still out when p2 opens
    h.answers.set('detectors:remove', () => ({ ok: true }));
    await click(q('dl-remove-crack'));
    await click(q('dl-remove-yes-crack'));
    expect(callsOf('detectors:list')).toHaveLength(2);

    // the rows of p1 go as soon as p2 opens, before its list is read
    act(() => {
      workspace.setState({ project: { id: 'p2' } as OpenProject });
    });
    expect(q('dl-row-project-crack')).toBeNull();
    // the reload started for p1 answers after the switch: dropped
    const late = pending.get('p1');
    pending.get('p2')?.({ items: [item('project', det('flue'))] });
    await flush();
    late?.({ items: [item('project', det('crack'))] });
    await flush();
    expect(q('dl-row-project-flue')).not.toBeNull();
    expect(q('dl-row-project-crack')).toBeNull();
  });

  it('reads stats at most four at a time', async () => {
    let running = 0;
    let most = 0;
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    h.answers.set('detectors:list', () => ({ items: ids.map((id) => item('library', det(id))) }));
    h.answers.set('ledger:stats', async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 0));
      running--;
      return NONE;
    });
    root = createRoot(host);
    act(() => root?.render(<DetectorLibrary />));
    for (let n = 0; n < 4; n++) await flush();
    expect(callsOf('ledger:stats')).toHaveLength(7);
    expect(most).toBe(4);
    expect(q('dl-stats-a7')?.textContent).toBe('No reviews yet');
  });

  it('stats that cannot be read say so', async () => {
    h.answers.set('detectors:list', () => ({ items: [item('library', det('chimney'))] }));
    root = createRoot(host);
    act(() => root?.render(<DetectorLibrary />));
    await flush();
    expect(q('dl-stats-chimney')?.textContent).toBe('Reviews could not be read');
  });

  it('a failed clear shows its error', async () => {
    await show([item('library', det('chimney'))], {
      chimney: { accepted: 1, rejected: 0, misses: 0, suggestedThreshold: null },
    });
    h.answers.set('ledger:clear', () => ({ ok: false, error: 'The ledger is locked.' }));
    await click(q('dl-clear-chimney'));
    await click(q('dl-clear-yes-chimney'));
    expect(q('dl-error')?.textContent).toBe('The ledger is locked.');
    expect(q('dl-stats-chimney')?.textContent).toContain('1 reviewed');
  });

  it('a failed remove shows its error, or a fallback when it has none', async () => {
    await show([item('library', det('chimney'))]);
    h.answers.set('detectors:remove', () => ({ ok: false, error: 'The folder is in use.' }));
    await click(q('dl-remove-chimney'));
    await click(q('dl-remove-yes-chimney'));
    expect(q('dl-error')?.textContent).toBe('The folder is in use.');
    h.answers.set('detectors:remove', () => ({ ok: false }));
    await click(q('dl-remove-chimney'));
    await click(q('dl-remove-yes-chimney'));
    expect(q('dl-error')?.textContent).toBe('That did not work. Try again.');
    expect(q('dl-row-library-chimney')).not.toBeNull();
  });
});
