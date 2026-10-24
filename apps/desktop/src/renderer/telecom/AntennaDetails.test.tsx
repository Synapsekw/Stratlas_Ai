// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaDeleteStore } from './antennaDelete';
import { AntennaDetails } from './AntennaDetails';
import { AntennaInventory } from './AntennaInventory';
import { antennaStore, filteredUnits, useAntennas, type AntennaFilter } from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ writes: 0 }));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string) => {
        if (channel === 'telecom:writeAntennas') {
          h.writes++;
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      }),
    },
  };
});
const photoOpen = vi.hoisted(() => ({ openPhoto: vi.fn() }));
vi.mock('../builder/photoOpen', () => photoOpen);
vi.mock('./antennaScene', () => ({
  KIND_COLOURS: { panel: '#111', short: '#222', dish: '#333', other: '#444' },
}));

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
      centre: [10.5, 20.25, 29.14],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.21, 1.3, 0.145],
    },
    support: 10330,
    azimuthGridDeg: measured(168),
    downtiltDeg: measured(0.3),
    plumbDeg: measured(-0.6),
    widthM: measured(0.42),
    heightM: measured(2.6),
    depthM: measured(0.29),
    convergenceDeg: 1.1,
    photos: [],
    user: {},
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const fileOf = (units: AntennaUnit[]) =>
  ({ schema: 'aio.antennas/1', run: { id: 'run-1' }, units }) as unknown as AntennasFile;

function load(
  units: AntennaUnit[],
  opts: { filter?: AntennaFilter; selected?: string | null; readOnly?: boolean } = {},
) {
  antennaStore.setState({
    projectId: 'p1',
    root: '/p',
    status: 'ready',
    file: fileOf(units),
    filter: opts.filter ?? 'all',
    selected: opts.selected === undefined ? (units[0]?.id ?? null) : opts.selected,
    readOnly: opts.readOnly ?? false,
    note: null,
    flagging: null,
    running: false,
    flagJob: null,
    flagStarting: false,
  });
}
const three = () => [unit('a1'), unit('a2'), unit('a3')];

/** The details of the selected unit, as the group shows them. */
function Harness() {
  const s = useAntennas((a) => a);
  const list = filteredUnits(s.file, s.filter);
  const u = s.file?.units.find((x) => x.id === s.selected);
  if (!u) return null;
  return (
    <AntennaDetails
      unit={u}
      readOnly={s.readOnly}
      position={list.findIndex((x) => x.id === u.id)}
      count={list.length}
    />
  );
}
/** The inventory wired to the store, for where the details open. */
function Inventory() {
  const s = useAntennas((a) => a);
  return (
    <AntennaInventory
      file={s.file}
      selected={s.selected}
      ticked={s.ticked}
      hidden={s.hidden}
      solo={s.solo}
      filter={s.filter}
      readOnly={s.readOnly}
      onSelect={(id) => {
        antennaStore.setState({ selected: id });
      }}
      onTick={() => undefined}
      onFilter={() => undefined}
    />
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.writes = 0;
  photoOpen.openPhoto.mockReset();
  antennaDeleteStore.setState({ ask: null, busy: false });
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
});

const show = (ui = <Harness />) => {
  act(() => {
    root.render(ui);
  });
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => {
    q(id)!.click();
  });
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const value = (name: string) => host.querySelector(`[data-value="${name}"]`)?.textContent;
const status = (id: string) => antennaStore.getState().file?.units.find((u) => u.id === id)?.status;

describe('AntennaDetails', () => {
  it('opens under the selected row only', () => {
    load(three(), { selected: 'a2' });
    show(<Inventory />);
    const details = host.querySelectorAll('[data-testid="antenna-details"]');
    expect(details).toHaveLength(1);
    const item = host.querySelector('[data-row-id="a2"]')!;
    expect(item.contains(details[0]!)).toBe(true);
    // directly under its own row
    expect(item.querySelector('[data-testid="antenna-row"]')!.nextElementSibling).toBe(details[0]);
    act(() => {
      antennaStore.setState({ selected: null });
    });
    expect(q('antenna-details')).toBeNull();
  });

  it('Accept and Reject decide the unit', async () => {
    load(three());
    show();
    click('antenna-details-accept');
    await settle();
    expect(status('a1')).toBe('accepted');
    click('antenna-details-reject');
    await settle();
    expect(status('a1')).toBe('rejected');
    expect(q('antenna-details-accept')!.textContent).toContain('A');
    expect(q('antenna-details-reject')!.textContent).toContain('R');
  });

  it('Delete asks to delete, detected units too', () => {
    load([unit('a1'), unit('f1', { origin: 'flagged', kindBasis: 'user' })]);
    show();
    expect(antennaStore.getState().file!.units[0]!.origin).toBeUndefined();
    click('antenna-details-delete');
    expect(antennaDeleteStore.getState().ask).toMatchObject({ ids: ['a1'] });
    // it only asks; the dialog's yes deletes
    expect(antennaStore.getState().file!.units).toHaveLength(2);
  });

  it('prev and next step the selection', () => {
    load(three());
    show();
    expect(q('antenna-details-position')!.textContent).toBe('1 / 3');
    click('antenna-details-next');
    expect(antennaStore.getState().selected).toBe('a2');
    expect(q('antenna-details-position')!.textContent).toBe('2 / 3');
    click('antenna-details-prev');
    click('antenna-details-prev');
    expect(antennaStore.getState().selected).toBe('a3');
  });

  it('shows the values, true north azimuth first, with the whole size on its own row', () => {
    load(three());
    show();
    expect(value('azimuth')).toBe('169.1°');
    expect(value('downtilt')).toBe('0.3°');
    expect(value('plumb')).toBe('-0.6°');
    expect(value('altitude')).toBe('29.1 m');
    expect(value('size')).toBe('0.42 × 2.60 × 0.29 m');
    expect(value('points')).toBe((10330).toLocaleString());
    expect(host.querySelector('[data-note="downtilt"]')?.textContent).toBe('mechanical');
  });

  it('shows elevation and diameter for a dish, and no downtilt', () => {
    load([
      unit('d1', {
        kind: 'dish',
        elevationDeg: measured(1.5),
        diameterM: measured(0.6),
        downtiltDeg: undefined,
      }),
    ]);
    show();
    expect(value('elevation')).toBe('+1.5°');
    expect(value('diameter')).toBe('0.60 m');
    expect(value('downtilt')).toBeUndefined();
  });

  it('picking a kind marks it as yours', async () => {
    load([unit('a1', { ai: { kind: 'panel', provider: 'x' } as unknown as AntennaUnit['ai'] })]);
    show();
    const pick = q('antenna-details-kind-pick') as HTMLSelectElement;
    expect(pick.value).toBe('panel');
    act(() => {
      pick.value = 'dish';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    const u = antennaStore.getState().file!.units[0]!;
    expect(u.kind).toBe('dish');
    expect(u.kindBasis).toBe('user');
    expect(q('antenna-details-kind-basis')!.textContent).toBe('set by you');
  });

  it('holds the photo strip, the Your values fold and the model fold', () => {
    workspace.setState({
      project: { id: 'p1', manifest: { layers: [] } } as unknown as OpenProject,
    });
    load([unit('a1', { crop: 'telecom/crops/a1.jpg' })]);
    show();
    const details = q('antenna-details')!;
    expect(details.contains(q('antenna-card-photos'))).toBe(true);
    expect(q('antenna-crop')).not.toBeNull();
    expect(details.contains(q('antenna-typed'))).toBe(true);
    expect(details.textContent).toContain('Model, weight, frequencies');
  });

  it('Redraw outline starts the tool for this unit, refused with a reason while busy', () => {
    load(three());
    show();
    click('antenna-details-redraw');
    expect(antennaStore.getState().flagging).toEqual({ unit: 'a1' });
    act(() => {
      antennaStore.setState({ flagging: null, running: true });
    });
    expect(q('antenna-details-redraw')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('read-only: kind, review, redraw and delete change nothing', async () => {
    load(three(), { readOnly: true });
    show();
    expect((q('antenna-details-kind-pick') as HTMLSelectElement).disabled).toBe(true);
    for (const id of ['accept', 'reject', 'redraw', 'delete'])
      expect(q(`antenna-details-${id}`)!.getAttribute('aria-disabled')).toBe('true');
    click('antenna-details-accept');
    click('antenna-details-delete');
    await settle();
    expect(h.writes).toBe(0);
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });
});
