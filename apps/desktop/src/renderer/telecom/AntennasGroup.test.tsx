// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
/**
 * The Antennas group of the Project tab's "In this project" list, in the real list: its header
 * (count, eye, Flag antenna), the filter chips and flat rows, the reveal hold, and the bulk bar.
 */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectList } from '../workspace/workbench/project/ProjectList';
import { projectListStore, revealInList } from '../workspace/workbench/project/projectListStore';
import { sectionStore } from '../workspace/workbench/sectionState';
import { antennaDeleteStore } from './antennaDelete';
import { antennasGroup } from './AntennasGroup';
import { antennaStore, selectAntenna, type AntennaState } from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ writes: [] as unknown[], clouds: 1 }));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string, req: { file?: unknown }) => {
        if (channel === 'telecom:writeAntennas') {
          h.writes.push(req.file);
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      }),
    },
  };
});
vi.mock('./AntennaRunner', () => ({
  useAntennaClouds: () => Array.from({ length: h.clouds }, (_, i) => ({ id: `c${String(i)}` })),
}));
vi.mock('./antennaScene', () => ({
  KIND_COLOURS: { panel: '#111', short: '#222', dish: '#333', other: '#444' },
}));
vi.mock('./AntennaFlagTool', () => ({
  AntennaFlagTool: () => <div data-testid="flag-tool" />,
}));
vi.mock('../builder/photoOpen', () => ({ openPhoto: () => undefined }));

const measured = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured' },
});
function unit(id: string, over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'draft',
    box: {
      centre: [1, 2, 30],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.3, 1.2, 0.15],
    },
    support: 100,
    azimuthGridDeg: measured(120),
    downtiltDeg: measured(2),
    convergenceDeg: null,
    photos: [],
    user: {},
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const fileOf = (units: AntennaUnit[], warnings: string[] = []) =>
  ({ schema: 'aio.antennas/1', run: { id: 'run-1', warnings }, units }) as unknown as AntennasFile;
const four = () => [
  unit('p1'),
  unit('p2', { status: 'accepted' }),
  unit('p3', { status: 'rejected' }),
  unit('p4'),
];

function load(units: AntennaUnit[] | null, over: Partial<AntennaState> = {}) {
  antennaStore.setState({
    ...antennaStore.getInitialState(),
    projectId: 'p1',
    root: '/p',
    status: 'ready',
    file: units ? fileOf(units) : null,
    ...over,
  });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.writes = [];
  h.clouds = 1;
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  antennaDeleteStore.setState({ ask: null, busy: false });
  workspace.setState({
    project: { id: 'p1', root: '/p', manifest: { layers: [] } },
  } as unknown as Parameters<typeof workspace.setState>[0]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
  workspace.setState({ project: null });
  vi.useRealTimers();
});

const show = (on = true) => {
  act(() => {
    root.render(on ? <ProjectList groups={[antennasGroup]} /> : null);
  });
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const section = () => q('wb-section-project-antennas');
const head = () => section()?.querySelector<HTMLButtonElement>(':scope > .wb-section-head') ?? null;
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="antenna-row"]')];
const click = (el: Element | null) => {
  act(() => {
    (el as HTMLElement).click();
  });
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const status = (id: string) => antennaStore.getState().file?.units.find((u) => u.id === id)?.status;

describe('the Antennas group', () => {
  it('is open by default, titled Antennas with the count of units not rejected', () => {
    load(four());
    show();
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(head()?.textContent).toBe('Antennas3');
    expect(rows()).toHaveLength(4);
    expect(q('antenna-panel')).not.toBeNull();
  });

  it('applies with a cloud and an inventory or a run, as the old section did', () => {
    load(null, { status: 'idle' });
    show();
    expect(section()).toBeNull();
    act(() => {
      antennaStore.setState({ running: true });
    });
    expect(section()).not.toBeNull();
    h.clouds = 0;
    load(four());
    show(false);
    show();
    expect(section()).toBeNull();
  });

  it('lists rejected units under the Rejected chip', () => {
    load(four());
    show();
    click(q('antenna-filter-rejected'));
    expect(rows().map((r) => r.textContent.slice(0, 2))).toEqual(['P3']);
  });

  it('scrolls inside itself beyond 8 rows', () => {
    load(Array.from({ length: 12 }, (_, i) => unit(`u${String(i)}`)));
    show();
    const list = section()!.querySelector<HTMLElement>('ul.pl-rows')!;
    expect(list.classList.contains('pl-rows')).toBe(true);
    expect(list.querySelectorAll('[data-row-id]')).toHaveLength(12);
    // the open details count beside the eight rows, never as rows
    expect(list.style.getPropertyValue('--pl-details-h')).toBe('0px');
  });

  it('header eye hides and shows all', () => {
    load(four());
    show();
    const actions = section()!.querySelector('.wb-section-actions')!;
    expect(actions.contains(q('antenna-hide-all'))).toBe(true);
    expect(q('antenna-show-all')).toBeNull();
    click(q('antenna-hide-all'));
    expect(Object.keys(antennaStore.getState().hidden)).toHaveLength(4);
    click(q('antenna-show-all'));
    expect(antennaStore.getState().hidden).toEqual({});
    // the eye never folds the group
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('Flag antenna is in the header and disabled with its reason while detection runs', () => {
    load(four(), { running: true });
    show();
    const flag = q('antenna-flag')!;
    expect(section()!.querySelector('.wb-section-actions')!.contains(flag)).toBe(true);
    expect(flag.getAttribute('aria-disabled')).toBe('true');
    const id = flag.getAttribute('aria-describedby') ?? '';
    expect(host.querySelector(`[id="${id}"]`)?.textContent).toBe(
      'Antenna detection is already running.',
    );
    act(() => {
      antennaStore.setState({ running: false });
    });
    expect(flag.getAttribute('aria-disabled')).toBeNull();
  });

  it('Flag antenna opens a folded group so its tool shows', () => {
    load(four());
    show();
    click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    click(q('antenna-flag'));
    expect(antennaStore.getState().flagging).toEqual({ unit: null });
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(q('flag-tool')).not.toBeNull();
  });

  it('with no inventory yet, shows Flag antenna disabled with its reason', () => {
    load(null);
    show();
    const flag = q('antenna-flag')!;
    expect(flag.getAttribute('aria-disabled')).toBe('true');
    const id = flag.getAttribute('aria-describedby') ?? '';
    expect(host.querySelector(`[id="${id}"]`)?.textContent).toBe('Run antenna detection first');
  });

  it('shows the warnings and the AI note above the rows', () => {
    load(null, { aiNote: 'offline' });
    antennaStore.setState({ file: fileOf(four(), ['Few points on the mast']) });
    show();
    const note = q('antenna-ai-note')!;
    expect(note.textContent).toBe('AI labelling skipped: offline');
    const panel = q('antenna-panel')!;
    expect(panel.textContent).toContain('Few points on the mast');
    const first = rows()[0]!;
    expect(note.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('a reveal of a row (a pick in 3D, another tool asking for the review)', () => {
  it('holds the folded group open without changing the person’s fold', () => {
    load(four());
    show();
    click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    const saved = JSON.stringify(sectionStore.getState().byBench);
    act(() => {
      selectAntenna('p2');
      revealInList('antennas', 'p2');
    });
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(JSON.stringify(sectionStore.getState().byBench)).toBe(saved);
    // the details open under the revealed row
    const item = host.querySelector('[data-row-id="p2"]')!;
    expect(item.contains(q('antenna-details'))).toBe(true);
    act(() => {
      selectAntenna(null);
    });
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a header click ends the hold and folds the group', () => {
    load(four());
    show();
    act(() => {
      selectAntenna('p1');
      revealInList('antennas', 'p1');
    });
    click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    expect(antennaStore.getState().selected).toBe('p1');
    click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('with nothing selected, holds the group open until the header folds it', () => {
    load(four());
    show();
    click(head());
    act(() => {
      revealInList('antennas', null);
    });
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the group when it mounts after the reveal (another tab was in front)', () => {
    load(four());
    show();
    click(head());
    show(false);
    act(() => {
      selectAntenna('p4');
      revealInList('antennas', 'p4');
    });
    show();
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    expect(projectListStore.getState().reveal?.id).toBe('p4');
  });
});

describe('the bulk bar', () => {
  const tick = (id: string) => {
    click(host.querySelector(`[data-row-id="${id}"] input[type="checkbox"]`));
  };

  it('shows only while a row is ticked, with the count', () => {
    load(four());
    show();
    expect(q('antenna-bulk')).toBeNull();
    tick('p1');
    tick('p4');
    expect(q('antenna-bulk')!.textContent).toContain('2 selected');
    expect(antennaStore.getState().selected).toBeNull();
  });

  it('accepts every ticked unit', async () => {
    load(four());
    show();
    tick('p1');
    tick('p3');
    click(q('antenna-bulk-accept'));
    await settle();
    expect(status('p1')).toBe('accepted');
    expect(status('p3')).toBe('accepted');
    expect(status('p4')).toBe('draft');
    expect(q('antenna-bulk')).toBeNull();
  });

  it('rejects every ticked unit', async () => {
    load(four());
    show();
    tick('p1');
    tick('p2');
    click(q('antenna-bulk-reject'));
    await settle();
    expect(status('p1')).toBe('rejected');
    expect(status('p2')).toBe('rejected');
  });

  it('deletes every ticked unit with one ask', () => {
    load(four());
    show();
    tick('p1');
    tick('p4');
    click(q('antenna-bulk-delete'));
    expect(antennaDeleteStore.getState().ask?.ids).toHaveLength(2);
    expect(antennaDeleteStore.getState().ask?.ids).toEqual(['p1', 'p4']);
  });

  it('clears with the cross', () => {
    load(four());
    show();
    tick('p1');
    const clear = q('antenna-bulk-clear')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear the selection');
    click(clear);
    expect(antennaStore.getState().ticked).toEqual({});
    expect(q('antenna-bulk')).toBeNull();
  });

  it('read-only: the bar changes nothing', async () => {
    load(four(), { readOnly: true, ticked: { p1: true } });
    show();
    click(q('antenna-bulk-accept'));
    click(q('antenna-bulk-delete'));
    await settle();
    expect(h.writes).toHaveLength(0);
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });
});
