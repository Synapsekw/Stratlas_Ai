// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaCard, resetCardDrag } from './AntennaCard';
import { antennaStore, type AntennaFilter } from './antennaStore';
import type { Rect } from './cardPlacement';

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
    filter: opts.filter ?? 'draft',
    selected: opts.selected === undefined ? (units[0]?.id ?? null) : opts.selected,
    readOnly: opts.readOnly ?? false,
    note: null,
  });
}
const three = () => [unit('a1'), unit('a2'), unit('a3')];

let stage: HTMLDivElement;
let mount: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.writes = 0;
  photoOpen.openPhoto.mockReset();
  resetCardDrag();
  stage = document.createElement('div');
  Object.defineProperty(stage, 'clientWidth', { value: 1000 });
  Object.defineProperty(stage, 'clientHeight', { value: 800 });
  mount = document.createElement('div');
  document.body.append(stage, mount);
  root = createRoot(mount);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
  workspace.setState({ project: null });
});

function show(boxRect: Rect | null = null) {
  act(() => {
    root.render(<AntennaCard stageHost={stage} boxRect={boxRect} />);
  });
}
const q = (id: string) => stage.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => {
    q(id)!.click();
  });
};
/** Let the store's queued write and its follow-up finish. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const value = (name: string) => stage.querySelector(`[data-value="${name}"]`)?.textContent;
const status = (id: string) => antennaStore.getState().file?.units.find((u) => u.id === id)?.status;
const press = (key: string, target: EventTarget = document.body) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

describe('AntennaCard', () => {
  it('renders nothing without a selected unit', () => {
    load(three(), { selected: null });
    show();
    expect(q('antenna-card')).toBeNull();
  });

  it('draws in the stage host with the position in the filtered list', () => {
    load(three());
    show();
    expect(stage.contains(q('antenna-card'))).toBe(true);
    expect(q('antenna-card-position')!.textContent).toBe('1 / 3');
    expect(q('antenna-card')!.textContent).toContain('A1');
    expect(q('antenna-card')!.textContent).toContain('Draft');
    expect(q('antenna-card')!.textContent).toContain('panel');
  });

  it('accepts and moves on to the next unit of the filter', async () => {
    load(three());
    show();
    click('antenna-card-accept');
    await settle();
    expect(status('a1')).toBe('accepted');
    expect(q('antenna-card')!.getAttribute('aria-label')).toBe('A2');
    expect(q('antenna-card-position')!.textContent).toBe('1 / 2');
  });

  it('steps with the arrows and closes with the cross', () => {
    load(three());
    show();
    click('antenna-card-next');
    expect(antennaStore.getState().selected).toBe('a2');
    expect(q('antenna-card-position')!.textContent).toBe('2 / 3');
    click('antenna-card-prev');
    click('antenna-card-prev');
    expect(antennaStore.getState().selected).toBe('a3');
    click('antenna-card-close');
    expect(antennaStore.getState().selected).toBeNull();
    expect(q('antenna-card')).toBeNull();
  });

  it('disables review with the read-only reason', async () => {
    load(three(), { readOnly: true });
    show();
    const accept = q('antenna-card-accept')!;
    expect(accept.getAttribute('aria-disabled')).toBe('true');
    expect(stage.textContent).toContain('Read-only package: review is not available');
    click('antenna-card-accept');
    await settle();
    expect(status('a1')).toBe('draft');
    expect(h.writes).toBe(0);
  });

  it('shows the crop from the project asset url', () => {
    load([unit('a1', { crop: 'telecom/crops/a1.jpg' })]);
    show();
    expect(q('antenna-crop')!.getAttribute('src')).toBe('aio://project/p1/telecom/crops/a1.jpg');
  });

  it('shows the values, true north azimuth first', () => {
    load(three());
    show();
    expect(value('azimuth')).toBe('169.1°');
    expect(value('downtilt')).toBe('0.3°');
    expect(value('plumb')).toBe('-0.6°');
    expect(value('size')).toBe('0.42×2.60×0.29');
    expect(value('altitude')).toBe('29.1 m');
    expect(value('points')).toBe((10330).toLocaleString());
  });

  it('shows elevation and diameter for a dish, and no downtilt', () => {
    load([unit('d1', { kind: 'dish', elevationDeg: measured(5), diameterM: measured(0.6) })]);
    show();
    expect(stage.textContent).toContain('Elevation');
    expect(stage.textContent).toContain('Diameter');
    expect(stage.textContent).not.toContain('Downtilt');
    expect(value('elevation')).toBe('+5.0°');
    expect(value('diameter')).toBe('0.60 m');
  });

  it('shows a dash for a value not measured', () => {
    load([unit('o1', { kind: 'other', azimuthGridDeg: undefined, plumbDeg: undefined })]);
    show();
    expect(value('azimuth')).toBe('—');
    expect(value('plumb')).toBe('—');
  });

  it('steps through the linked photos and opens the current one', () => {
    workspace.setState({
      project: {
        id: 'p1',
        root: '/p',
        manifest: {
          layers: [
            {
              kind: 'photos',
              id: 'L1',
              items: [
                { id: 'p-a', src: { path: 'photos/a.jpg' } },
                { id: 'p-b', src: { path: 'photos/b.jpg' } },
              ],
            },
          ],
        },
      } as unknown as OpenProject,
    });
    load([
      unit('a1', {
        crop: 'telecom/crops/a1.jpg',
        photos: [
          { layer: 'L1', id: 'p-a', score: 0.9 },
          { layer: 'L1', id: 'p-b', score: 0.5 },
        ],
      }),
    ]);
    show();
    expect(q('antenna-card-photo-index')!.textContent).toBe('photo 1 / 3');
    // the crop opens the first linked photo
    click('antenna-card-open-photo');
    expect(photoOpen.openPhoto).toHaveBeenLastCalledWith('L1', 'p-a');
    click('antenna-card-photo-next');
    click('antenna-card-photo-next');
    expect(q('antenna-card-photo-index')!.textContent).toBe('photo 3 / 3');
    expect(q('antenna-crop')).toBeNull();
    const img = q('antenna-photo-img')!;
    expect(img.getAttribute('src')).toBe('aio://thumb/p1/photos/b.jpg');
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(q('antenna-photo-img')!.getAttribute('src')).toBe('aio://project/p1/photos/b.jpg');
    click('antenna-card-open-photo');
    expect(photoOpen.openPhoto).toHaveBeenLastCalledWith('L1', 'p-b');
    click('antenna-card-photo-next');
    expect(q('antenna-card-photo-index')!.textContent).toBe('photo 1 / 3');
  });

  it('sits right of the box with a leader line, and docks without a box', () => {
    load(three());
    show({ x: 400, y: 200, w: 60, h: 300 });
    const card = q('antenna-card')!;
    expect(card.style.left).toBe('476px');
    expect(card.style.top).toBe(`${String(350 - 420 / 2)}px`);
    const line = q('antenna-card-leader')!.querySelector('line')!;
    expect(line.getAttribute('x1')).toBe('460');
    expect(line.getAttribute('y1')).toBe('350');
    expect(line.getAttribute('x2')).toBe('476');
    show(null);
    expect(card.style.left).toBe('672px');
    expect(card.style.top).toBe('8px');
    expect(card.dataset.docked).toBe('true');
    expect(q('antenna-card-leader')).toBeNull();
  });

  it('stays where it was dragged until the drag is reset', () => {
    load(three());
    show({ x: 400, y: 200, w: 60, h: 300 });
    const head = q('antenna-card-head')!;
    const pointer = (type: string, x: number, y: number) => {
      act(() => {
        head.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }),
        );
      });
    };
    pointer('pointerdown', 500, 150);
    pointer('pointermove', 324, 50);
    pointer('pointerup', 324, 50);
    const card = q('antenna-card')!;
    expect(card.style.left).toBe('300px');
    expect(card.style.top).toBe('40px');
    click('antenna-card-next');
    expect(card.style.left).toBe('300px');
    act(() => {
      resetCardDrag();
    });
    expect(card.style.left).toBe('476px');
  });
});

describe('AntennaCard keys', () => {
  it('A accepts the selected draft', async () => {
    load(three());
    show();
    press('a');
    await settle();
    expect(status('a1')).toBe('accepted');
    expect(antennaStore.getState().selected).toBe('a2');
  });

  it('R rejects', async () => {
    load(three());
    show();
    press('R');
    await settle();
    expect(status('a1')).toBe('rejected');
  });

  it('the arrows step and Escape closes', () => {
    load(three());
    show();
    press('ArrowRight');
    expect(antennaStore.getState().selected).toBe('a2');
    press('ArrowDown');
    expect(antennaStore.getState().selected).toBe('a3');
    press('ArrowUp');
    press('ArrowLeft');
    expect(antennaStore.getState().selected).toBe('a1');
    press('Escape');
    expect(antennaStore.getState().selected).toBeNull();
    expect(q('antenna-card')).toBeNull();
  });

  it('typing a in the model field edits the field, not the status', async () => {
    load(three());
    show();
    const label = [...stage.querySelectorAll('label')].find((l) =>
      l.textContent.startsWith('Model'),
    )!;
    const input = label.querySelector('input')!;
    press('a', input);
    act(() => {
      // the native setter, so React sees the change
      Reflect.set(HTMLInputElement.prototype, 'value', 'a', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(input.value).toBe('a');
    expect(status('a1')).toBe('draft');
    expect(h.writes).toBe(0);
  });

  it('does nothing while a modal dialog is open', async () => {
    load(three());
    show();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    press('a');
    press('ArrowRight');
    await settle();
    expect(status('a1')).toBe('draft');
    expect(antennaStore.getState().selected).toBe('a1');
  });

  it('ignores keys held with a modifier or already handled', async () => {
    load(three());
    show();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    });
    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    await settle();
    expect(status('a1')).toBe('draft');
    expect(antennaStore.getState().selected).toBe('a1');
  });

  it('ignores a held A (auto-repeat) but takes a fresh press', async () => {
    load(three());
    show();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', repeat: true, cancelable: true }),
      );
    });
    await settle();
    expect(status('a1')).toBe('draft');
    expect(h.writes).toBe(0);
    press('a');
    await settle();
    expect(status('a1')).toBe('accepted');
  });

  it('read-only: A writes nothing', async () => {
    load(three(), { readOnly: true });
    show();
    press('a');
    await settle();
    expect(status('a1')).toBe('draft');
    expect(h.writes).toBe(0);
  });

  it('stops listening once the card has no unit', () => {
    load(three());
    show();
    press('Escape');
    press('ArrowRight');
    expect(antennaStore.getState().selected).toBeNull();
  });
});
