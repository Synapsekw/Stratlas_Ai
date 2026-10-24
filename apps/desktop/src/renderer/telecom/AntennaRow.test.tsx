// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from './antennaStore';
import { AntennaRow, type AntennaRowProps } from './AntennaRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  setTypedValue: vi.fn<(id: string, key: string, value: number) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  askDeleteAntennas: vi.fn(),
}));
vi.mock('./antennaStore', async (importOriginal) => ({
  ...(await importOriginal<typeof StoreModule>()),
  setTypedValue: h.setTypedValue,
}));
vi.mock('./antennaDelete', () => ({ askDeleteAntennas: h.askDeleteAntennas }));
vi.mock('./antennaScene', () => ({
  KIND_COLOURS: { panel: '#111', short: '#222', dish: '#333', other: '#444' },
}));

const measured = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured' },
});
function unit(over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id: 'a1',
    name: 'P1',
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.setTypedValue.mockClear();
  h.askDeleteAntennas.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

function show(p: Partial<AntennaRowProps> = {}) {
  const cb = { onSelect: vi.fn(), onTick: vi.fn() };
  act(() => {
    root.render(
      <ul>
        <AntennaRow
          unit={unit()}
          selected={false}
          ticked={false}
          readOnly={false}
          north="project"
          {...cb}
          {...p}
        />
      </ul>,
    );
  });
  return cb;
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function type(el: HTMLInputElement, text: string) {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', text, el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (el: HTMLElement, k: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

describe('AntennaRow', () => {
  it('is a tree item carrying its id, name, kind, height and status', () => {
    show({ selected: true });
    const item = host.querySelector<HTMLElement>('[data-row-id="a1"]')!;
    const row = q('antenna-row')!;
    expect(item.contains(row)).toBe(true);
    expect(row.getAttribute('role')).toBe('treeitem');
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.textContent).toContain('P1');
    expect(row.textContent).toContain('panel');
    expect(row.textContent).toContain('30.0');
  });

  it('shows the status chip with a dot', () => {
    show({ unit: unit({ status: 'accepted' }) });
    const chip = q('antenna-row')!.querySelector('.chip-status')!;
    expect(chip.textContent).toBe('Accepted');
    expect(chip.getAttribute('data-tone')).toBe('acc');
    expect(chip.querySelector('.dot')).not.toBeNull();
  });

  it('saves a typed azimuth on Enter and blur, Esc reverts', () => {
    // true north on the row, stored as grid
    show({ unit: unit({ convergenceDeg: 1.5 }), north: 'true' });
    const az = q('antenna-row-az') as HTMLInputElement;
    expect(az.value).toBe('121.5');
    expect(az.getAttribute('aria-label')).toBe('Azimuth, true north (°)');
    type(az, '100');
    key(az, 'Enter');
    act(() => {
      az.focus();
      az.blur();
    });
    expect(h.setTypedValue).toHaveBeenCalledTimes(1);
    expect(h.setTypedValue).toHaveBeenCalledWith('a1', 'azimuthGridDeg', 98.5);
    // Esc puts the shown value back and writes nothing
    const tilt = q('antenna-row-tilt') as HTMLInputElement;
    type(tilt, '7');
    key(tilt, 'Escape');
    expect(tilt.value).toBe('2');
    act(() => {
      tilt.focus();
      tilt.blur();
    });
    expect(h.setTypedValue).toHaveBeenCalledTimes(1);
  });

  it('shows a dash for the tilt of a dish', () => {
    const dish = unit({ kind: 'dish' });
    delete dish.downtiltDeg;
    show({ unit: dish });
    const tilt = q('antenna-row-tilt')!;
    expect(tilt.tagName).not.toBe('INPUT');
    expect(tilt.textContent).toBe('—');
  });

  it('trash asks to delete this unit', () => {
    const cb = show();
    const trash = q('antenna-row-delete')!;
    expect(trash.getAttribute('aria-label')).toBe('Delete P1');
    act(() => {
      trash.click();
    });
    expect(h.askDeleteAntennas).toHaveBeenCalledWith(['a1']);
    expect(cb.onSelect).not.toHaveBeenCalled();
  });

  it('ticking does not select', () => {
    const cb = show();
    const tick = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(tick.getAttribute('aria-label')).toBe('Select P1');
    act(() => {
      tick.click();
    });
    expect(cb.onTick).toHaveBeenCalledWith('a1');
    expect(cb.onSelect).not.toHaveBeenCalled();
  });

  it('selects on a click and from the keyboard', () => {
    const cb = show();
    const row = q('antenna-row')!;
    act(() => {
      row.click();
    });
    key(row, 'Enter');
    key(row, ' ');
    expect(cb.onSelect).toHaveBeenCalledTimes(3);
    expect(cb.onSelect).toHaveBeenCalledWith('a1');
  });

  it('read-only: the fields are disabled and the trash says why', () => {
    show({ readOnly: true });
    expect((q('antenna-row-az') as HTMLInputElement).disabled).toBe(true);
    const trash = q('antenna-row-delete')!;
    expect(trash.getAttribute('aria-disabled')).toBe('true');
  });

  it('hands a right-click to its menu', () => {
    const onContextMenu = vi.fn();
    show({ onContextMenu });
    act(() => {
      q('antenna-row')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0]![1]).toBe('a1');
  });

  it('renders what it is given under the row, inside the same item', () => {
    act(() => {
      root.render(
        <ul>
          <AntennaRow
            unit={unit()}
            selected
            ticked={false}
            readOnly={false}
            north="project"
            onSelect={() => undefined}
            onTick={() => undefined}
          >
            <div data-testid="under" />
          </AntennaRow>
        </ul>,
      );
    });
    expect(host.querySelector('[data-row-id="a1"]')!.contains(q('under'))).toBe(true);
    const group = q('under')!.parentElement!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('P1');
  });

  it('adds no group when nothing is under the row', () => {
    show();
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  it('Esc in a field is the field’s: window listeners do not see it', () => {
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      show();
      const az = q('antenna-row-az') as HTMLInputElement;
      type(az, '7');
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        az.dispatchEvent(e);
      });
      expect(e.defaultPrevented).toBe(true);
      expect(onWindow).not.toHaveBeenCalled();
      expect(az.value).toBe('120');
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });
});
