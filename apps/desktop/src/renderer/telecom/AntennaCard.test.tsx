// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaDeleteStore } from './antennaDelete';
import {
  ANTENNA_CARD_SELECTOR,
  AntennaCard,
  STRIP_MAX_H,
  STRIP_MIN_H,
  resetCardDrag,
  stripHeight,
} from './AntennaCard';
import { AntennaInventory } from './AntennaInventory';
import { antennaStore, selectAntenna, type AntennaFilter } from './antennaStore';
import { AVOID_WEIGHT, type Rect } from './cardPlacement';

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

  it('carries a stable marker other stage overlays find it by', () => {
    load(three());
    show();
    expect(stage.querySelector(ANTENNA_CARD_SELECTOR)).toBe(q('antenna-card'));
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

  it('keeps the whole name in the header, the kind and how it was found beside it', () => {
    load([
      unit('a14', {
        status: 'accepted',
        kindBasis: 'ai',
        ai: { provider: 'anthropic', model: 'm', promptVersion: 'v1', runId: 'ai-1' },
      }),
    ]);
    show();
    const name = q('antenna-card-name')!;
    expect(name.textContent).toBe('A14');
    expect(name.style.flexShrink).toBe('0');
    expect(name.style.textOverflow).toBe('');
    expect(q('antenna-card-kind')!.textContent).toBe('panel · labelled by AI (anthropic)');
    expect(q('antenna-card-kind-basis')!.textContent).toBe('labelled by AI (anthropic)');
  });

  it('shows the mechanical note only when the unit has a downtilt', () => {
    load([unit('a1', { kind: 'other', downtiltDeg: undefined })]);
    show();
    expect(stage.querySelector('[data-value="downtilt"]')!.textContent).toBe('—');
    expect(stage.querySelector('[data-note="downtilt"]')).toBeNull();
  });

  it('says a geometric kind is from geometry', () => {
    load(three());
    show();
    expect(q('antenna-card-kind-basis')!.textContent).toBe('from geometry');
  });

  it('gives each value its basis and fit quality as a tip, and notes the tilt is mechanical', () => {
    vi.useFakeTimers();
    try {
      load([
        unit('a1', {
          downtiltDeg: {
            value: 2,
            basis: 'inferred',
            quality: { basis: 'inferred', residualM: 0.003, support: 812, coverage: 0.74 },
          },
        }),
      ]);
      show();
      const dd = stage.querySelector<HTMLElement>('[data-value="downtilt"]')!;
      expect(dd.dataset.basis).toBe('inferred');
      expect(value('downtilt')).toBe('2.0°');
      expect(stage.querySelector('[data-note="downtilt"]')!.textContent).toBe('mechanical');
      const span = dd.querySelector<HTMLElement>('span[tabindex="0"]')!;
      expect(span.style.textDecoration).toContain('dotted');
      act(() => {
        span.focus();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      const tip = document.querySelector('[role="tooltip"]')!;
      expect(tip.textContent).toBe(
        'Inferred · Fit residual 3.0 mm, 812 points, 74% coverage · Mechanical tilt only. ' +
          'Electrical tilt is inside the antenna and is not measured.',
      );
      // a measured value has no underline
      const az = stage.querySelector<HTMLElement>('[data-value="azimuth"] span[tabindex="0"]')!;
      expect(az.style.textDecoration).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sizes the photo strip from the image, with a blurred fill instead of bars', () => {
    load([unit('a1', { crop: 'telecom/crops/a1.jpg' })]);
    show();
    const crop = q('antenna-crop')!;
    Object.defineProperty(crop, 'naturalWidth', { value: 40 });
    Object.defineProperty(crop, 'naturalHeight', { value: 260 });
    act(() => {
      crop.dispatchEvent(new Event('load'));
    });
    const strip = q('antenna-card-photos')!;
    expect(strip.style.height).toBe(`${String(STRIP_MAX_H)}px`);
    const fill = q('antenna-photo-fill')!;
    expect(fill.getAttribute('aria-hidden')).toBe('true');
    expect(fill.style.backgroundImage).toContain('telecom/crops/a1.jpg');
    expect(fill.style.filter).toContain('blur');
    expect(stripHeight(400, 300, 288)).toBe(216);
    expect(stripHeight(1000, 100, 288)).toBe(STRIP_MIN_H);
  });

  it('shows the values, true north azimuth first', () => {
    load(three());
    show();
    expect(value('azimuth')).toBe('169.1°');
    expect(value('downtilt')).toBe('0.3°');
    expect(value('plumb')).toBe('-0.6°');
    expect(value('size')).toBe('0.42 × 2.60 × 0.29 m');
    expect(value('altitude')).toBe('29.1 m');
    expect(value('points')).toBe((10330).toLocaleString());
  });

  it('shows the whole W × H × D on a row of its own, wrapping rather than cut', () => {
    load(three());
    show();
    const dd = stage.querySelector<HTMLElement>('[data-value="size"]')!;
    expect(dd.textContent).toBe('0.42 × 2.60 × 0.29 m');
    expect(dd.style.textOverflow).toBe('');
    expect(dd.style.whiteSpace).toBe('');
    expect(dd.parentElement!.style.gridColumn).toBe('1 / -1');
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

  it('shows Not measured for the values a flagged unit has none of', () => {
    const rest: AntennaUnit = { ...unit('f1') };
    delete rest.azimuthGridDeg;
    delete rest.downtiltDeg;
    delete rest.plumbDeg;
    delete rest.widthM;
    delete rest.heightM;
    delete rest.depthM;
    load([{ ...rest, origin: 'flagged' }]);
    show();
    expect(value('azimuth')).toBe('Not measured');
    expect(value('downtilt')).toBe('Not measured');
    expect(value('size')).toBe('Not measured');
    expect(value('altitude')).toBe('29.1 m');
  });

  it('shows a typed centre elevation as yours in the altitude row', () => {
    load([
      unit('c1', {
        centreHeightM: { value: 31.25, basis: 'user', quality: { basis: 'user' } },
      }),
    ]);
    show();
    expect(value('altitude')).toBe('31.3 m');
    expect(stage.querySelector('[data-value="altitude"]')?.getAttribute('data-basis')).toBe('user');
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

  it('caps its height to the free band on a narrow stage, Accept and Reject still in the row', () => {
    load(three());
    const narrow = document.createElement('div');
    Object.defineProperty(narrow, 'clientWidth', { value: 488 });
    Object.defineProperty(narrow, 'clientHeight', { value: 720 });
    document.body.append(narrow);
    const unitBox = { x: 226, y: 317, w: 37, h: 86 };
    act(() => {
      root.render(
        <AntennaCard
          stageHost={narrow}
          boxRect={{ x: 192, y: 266, w: 266, h: 143 }}
          avoid={[
            { rect: unitBox, weight: AVOID_WEIGHT.box },
            { rect: { x: 198, y: 272, w: 91, h: 20 }, weight: AVOID_WEIGHT.name },
          ]}
        />,
      );
    });
    const card = narrow.querySelector<HTMLElement>('[data-testid="antenna-card"]')!;
    // the full card (420 px here) has no room; below the box: 403 + 16 to 720 - 8
    expect(card.dataset.capped).toBe('true');
    expect(card.style.maxHeight).toBe(`${String(720 - 8 - 419)}px`);
    expect(card.style.top).toBe('419px');
    expect(card.dataset.unitBox).toBe('226 317 37 86');
    // the leader runs from the box's foot to the capped card's top edge
    const line = narrow.querySelector('[data-testid="antenna-card-leader"] line')!;
    expect(line.getAttribute('y1')).toBe('403');
    expect(line.getAttribute('y2')).toBe('419');
    // the actions are a row of their own below the scrolling middle
    const actions = narrow.querySelector('[data-testid="antenna-card-actions"]')!;
    const body = narrow.querySelector('[data-testid="antenna-card-body"]')!;
    expect(actions.querySelector('[data-testid="antenna-card-accept"]')).not.toBeNull();
    expect(actions.querySelector('[data-testid="antenna-card-reject"]')).not.toBeNull();
    expect(body.contains(actions)).toBe(false);
    expect(body.nextElementSibling).toBe(actions);
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

  it('wins over another window key handler for its keys only', async () => {
    load(three());
    show();
    const other = vi.fn();
    window.addEventListener('keydown', other);
    press('a');
    await settle();
    expect(status('a1')).toBe('accepted');
    expect(other).not.toHaveBeenCalled();
    press('x');
    expect(other).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', other);
  });

  it('steps and closes from a focused row of the antenna inventory', () => {
    load(three(), { selected: null });
    const panel = document.createElement('div');
    document.body.append(panel);
    const panelRoot = createRoot(panel);
    const renderPanel = () => {
      const st = antennaStore.getState();
      act(() => {
        panelRoot.render(
          <AntennaInventory
            file={st.file}
            selected={st.selected}
            ticked={{}}
            hidden={{}}
            solo={null}
            filter={st.filter}
            readOnly={false}
            onSelect={selectAntenna}
            onTick={() => undefined}
            onFilter={() => undefined}
          />,
        );
      });
    };
    renderPanel();
    show();
    const row = panel.querySelectorAll<HTMLElement>('[data-testid="antenna-row"]')[0]!;
    act(() => {
      row.focus();
      row.click();
    });
    show();
    expect(antennaStore.getState().selected).toBe('a1');
    expect(document.activeElement).toBe(row);
    press('ArrowRight', row);
    expect(antennaStore.getState().selected).toBe('a2');
    expect(q('antenna-card-position')!.textContent).toBe('2 / 3');
    press('Escape', row);
    expect(antennaStore.getState().selected).toBeNull();
    act(() => {
      panelRoot.unmount();
    });
  });

  it('leaves the arrows to another tree (the datasets sidebar)', () => {
    load(three());
    show();
    const tree = document.createElement('div');
    tree.setAttribute('role', 'tree');
    const item = document.createElement('div');
    item.setAttribute('role', 'treeitem');
    item.tabIndex = 0;
    tree.append(item);
    document.body.append(tree);
    press('ArrowRight', item);
    expect(antennaStore.getState().selected).toBe('a1');
  });

  it('leaves the arrows to a focused widget that owns them, and steps from the body', () => {
    load(three());
    show();
    const tabs = document.createElement('div');
    tabs.setAttribute('role', 'tablist');
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tabs.append(tab);
    document.body.append(tabs);
    tab.focus();
    press('ArrowRight', tab);
    expect(antennaStore.getState().selected).toBe('a1');
    tabs.remove();
    press('ArrowRight');
    expect(antennaStore.getState().selected).toBe('a2');
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

describe('AntennaCard editing', () => {
  beforeEach(() => {
    antennaStore.setState({ flagging: null, running: false, flagJob: null });
  });
  const flagged = (id: string) => unit(id, { origin: 'flagged', kindBasis: 'user' });

  it('shows the typed values under the values', () => {
    load(three());
    show();
    const typed = q('antenna-typed')!;
    expect(q('antenna-card-body')!.contains(typed)).toBe(true);
    expect(q('antenna-typed-azimuthGridDeg')).not.toBeNull();
  });

  it('Delete shows for flagged units only', async () => {
    load([unit('a1'), flagged('f1')], { filter: 'all' });
    show();
    expect(q('antenna-card-redraw')).not.toBeNull();
    expect(q('antenna-card-delete')).toBeNull();
    act(() => {
      selectAntenna('f1');
    });
    expect(q('antenna-card-delete')).not.toBeNull();
    click('antenna-card-delete');
    await settle();
    // the card only asks; the dialog's yes deletes
    expect(antennaDeleteStore.getState().ask).toMatchObject({ ids: ['f1'] });
    expect(antennaStore.getState().file!.units.map((u) => u.id)).toEqual(['a1', 'f1']);
  });

  it('Redraw outline starts the tool for this unit', () => {
    load(three());
    show();
    click('antenna-card-redraw');
    expect(antennaStore.getState().flagging).toEqual({ unit: 'a1' });
  });

  it('Redraw outline is disabled with a reason while a detection or a flag job runs', () => {
    load(three());
    antennaStore.setState({ running: true, flagging: null });
    show();
    const redraw = () => q('antenna-card-redraw')!;
    const reason = () =>
      stage.querySelector(`[id="${redraw().getAttribute('aria-describedby') ?? ''}"]`)?.textContent;
    expect(redraw().getAttribute('aria-disabled')).toBe('true');
    expect(reason()).toBe('Antenna detection is already running.');
    act(() => {
      antennaStore.setState({ running: false, flagJob: { id: 'jf', unit: 'a2' } });
    });
    expect(reason()).toBe('Wait for the flagged antenna to be measured.');
    click('antenna-card-redraw');
    expect(antennaStore.getState().flagging).toBeNull();
    act(() => {
      antennaStore.setState({ flagJob: null });
    });
    expect(redraw().getAttribute('aria-disabled')).toBeNull();
  });

  it('picking a kind marks it as yours', async () => {
    load([unit('a1', { ai: { kind: 'panel', provider: 'x' } as unknown as AntennaUnit['ai'] })]);
    show();
    const pick = q('antenna-card-kind-pick') as HTMLSelectElement;
    expect(pick.value).toBe('panel');
    expect(pick.getAttribute('aria-label')).toBe('Kind');
    act(() => {
      pick.value = 'dish';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    const u = antennaStore.getState().file!.units[0]!;
    expect(u.kind).toBe('dish');
    expect(u.kindBasis).toBe('user');
    expect(u.ai).toBeUndefined();
    expect(q('antenna-card-kind-basis')!.textContent).toBe('set by you');
  });

  it('picking a kind does not start a header drag', () => {
    load(three());
    show();
    const pick = q('antenna-card-kind-pick')!;
    const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      pick.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
  });

  it('read-only: kind, redraw and delete change nothing', async () => {
    load([flagged('f1')], { filter: 'all', readOnly: true });
    show();
    expect((q('antenna-card-kind-pick') as HTMLSelectElement).disabled).toBe(true);
    expect(q('antenna-card-redraw')!.getAttribute('aria-disabled')).toBe('true');
    expect(q('antenna-card-delete')!.getAttribute('aria-disabled')).toBe('true');
    click('antenna-card-redraw');
    click('antenna-card-delete');
    await settle();
    expect(antennaStore.getState().flagging).toBeNull();
    expect(antennaStore.getState().file!.units).toHaveLength(1);
    expect(h.writes).toBe(0);
  });

  it('a typed true azimuth is what the card Azimuth reads', async () => {
    load(three());
    show();
    const el = q('antenna-typed-azimuthGridDeg') as HTMLInputElement;
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', '271', el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(value('azimuth')).toBe('271.0°');
  });

  it('Reset to measured on the card puts the measured value back', async () => {
    load([
      unit('a1', {
        azimuthGridDeg: { value: 175, basis: 'user', quality: { basis: 'user' } },
        measured: { azimuthGridDeg: measured(168) },
      }),
    ]);
    show();
    click('antenna-typed-reset-azimuthGridDeg');
    await settle();
    expect(antennaStore.getState().file!.units[0]!.azimuthGridDeg).toEqual(measured(168));
    expect(value('azimuth')).toBe('169.1°');
  });
});
