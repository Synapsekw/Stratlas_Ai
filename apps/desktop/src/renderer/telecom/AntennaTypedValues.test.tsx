// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaTypedField, AntennaTypedValues } from './AntennaTypedValues';
import { antennaStore, useAntennas } from './antennaStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ writes: 0, fail: false }));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string) => {
        if (channel === 'telecom:writeAntennas') {
          if (h.fail) return Promise.resolve({ ok: false, error: 'disk full' });
          h.writes++;
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      }),
    },
  };
});

const measured = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured' },
});
const typed = (value: number): AntennaValue => ({
  value,
  basis: 'user',
  quality: { basis: 'user' },
});
function unit(over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id: 'a1',
    name: 'A1',
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'draft',
    box: {
      centre: [10, 20, 30],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.42, 2.6, 0.29],
    },
    support: 1000,
    azimuthGridDeg: measured(168),
    downtiltDeg: measured(2),
    plumbDeg: measured(0),
    widthM: measured(0.42),
    heightM: measured(2.6),
    depthM: measured(0.29),
    convergenceDeg: null,
    photos: [],
    user: {},
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const notMeasured = (): AntennaUnit => {
  const u = unit({ origin: 'flagged', kindBasis: 'user', support: 12 });
  delete u.azimuthGridDeg;
  delete u.downtiltDeg;
  delete u.plumbDeg;
  delete u.widthM;
  delete u.heightM;
  delete u.depthM;
  return u;
};

function load(u: AntennaUnit, readOnly = false) {
  antennaStore.setState({
    projectId: 'p1',
    root: '/p',
    status: 'ready',
    file: { schema: 'aio.antennas/1', run: { id: 'run-1' }, units: [u] } as unknown as AntennasFile,
    filter: 'all',
    selected: u.id,
    readOnly,
    note: null,
  });
}
const stored = () => antennaStore.getState().file!.units[0]!;

function Harness() {
  const u = useAntennas((s) => s.file?.units[0]);
  const readOnly = useAntennas((s) => s.readOnly);
  return u ? <AntennaTypedValues unit={u} readOnly={readOnly} /> : null;
}

let mount: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.writes = 0;
  h.fail = false;
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

const show = () => {
  act(() => {
    root.render(<Harness />);
  });
};
const q = (id: string) => mount.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (key: string) => q(`antenna-typed-${key}`) as HTMLInputElement | null;
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
function type(el: HTMLInputElement, text: string) {
  act(() => {
    // the prototype's setter, so React's value tracker sees a change
    Reflect.set(HTMLInputElement.prototype, 'value', text, el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const enter = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};
const blur = (el: HTMLElement) => {
  act(() => {
    el.focus();
    el.blur();
  });
};

describe('AntennaTypedValues', () => {
  it('is collapsed for a measured unit and open for a not-measured one', () => {
    load(unit());
    show();
    expect((q('antenna-typed') as HTMLDetailsElement).open).toBe(false);
    expect(mount.textContent).toContain('Your values');
    load(notMeasured());
    act(() => {
      root.unmount();
    });
    root = createRoot(mount);
    show();
    expect((q('antenna-typed') as HTMLDetailsElement).open).toBe(true);
  });

  it('prefills each input with the current value', () => {
    load(unit());
    show();
    expect(input('azimuthGridDeg')!.value).toBe('168');
    expect(input('downtiltDeg')!.value).toBe('2');
    expect(input('centreHeightM')!.value).toBe('30');
    expect(input('widthM')!.value).toBe('0.42');
    expect(input('heightM')!.value).toBe('2.6');
    expect(input('depthM')!.value).toBe('0.29');
  });

  it('typing an azimuth writes a user value', async () => {
    load(unit());
    show();
    type(input('azimuthGridDeg')!, '172.5');
    enter(input('azimuthGridDeg')!);
    await settle();
    expect(stored().azimuthGridDeg).toEqual(typed(172.5));
    expect(stored().measured?.azimuthGridDeg).toEqual(measured(168));
    expect(h.writes).toBe(1);
  });

  it('commits on blur, once', async () => {
    load(unit());
    show();
    type(input('widthM')!, '0.5');
    enter(input('widthM')!);
    blur(input('widthM')!);
    await settle();
    expect(stored().widthM).toEqual(typed(0.5));
    expect(h.writes).toBe(1);
  });

  it('an out-of-range downtilt shows the range and writes nothing', async () => {
    load(unit());
    show();
    type(input('downtiltDeg')!, '120');
    blur(input('downtiltDeg')!);
    await settle();
    expect(mount.textContent).toContain('Enter a number from -90 to 90.');
    expect(input('downtiltDeg')!.getAttribute('aria-invalid')).toBe('true');
    expect(stored().downtiltDeg).toEqual(measured(2));
    expect(h.writes).toBe(0);
  });

  it('an empty entry writes nothing', async () => {
    load(unit());
    show();
    type(input('heightM')!, '  ');
    enter(input('heightM')!);
    blur(input('heightM')!);
    await settle();
    expect(stored().heightM).toEqual(measured(2.6));
    expect(h.writes).toBe(0);
  });

  it('an unchanged value writes nothing', async () => {
    load(unit());
    show();
    enter(input('azimuthGridDeg')!);
    blur(input('azimuthGridDeg')!);
    await settle();
    expect(h.writes).toBe(0);
  });

  it('the same number written differently writes nothing', async () => {
    load(unit());
    show();
    type(input('azimuthGridDeg')!, '168.0');
    enter(input('azimuthGridDeg')!);
    blur(input('azimuthGridDeg')!);
    await settle();
    expect(stored().azimuthGridDeg).toEqual(measured(168));
    expect(h.writes).toBe(0);
  });

  it('an entry whose write failed can be committed again', async () => {
    load(unit());
    show();
    h.fail = true;
    type(input('widthM')!, '0.5');
    enter(input('widthM')!);
    await settle();
    expect(stored().widthM).toEqual(measured(0.42));
    h.fail = false;
    enter(input('widthM')!);
    await settle();
    expect(stored().widthM).toEqual(typed(0.5));
    expect(h.writes).toBe(1);
  });

  it('without the convergence the azimuth is in project north', () => {
    load(unit());
    show();
    expect(mount.textContent).toContain('Azimuth, project north (°)');
    expect(input('azimuthGridDeg')!.value).toBe('168');
  });

  it('with the convergence the azimuth reads and is typed in true north, stored as grid', async () => {
    load(unit({ convergenceDeg: 1.1 }));
    show();
    expect(mount.textContent).toContain('Azimuth, true north (°)');
    expect(input('azimuthGridDeg')!.value).toBe('169.1');
    type(input('azimuthGridDeg')!, '271');
    enter(input('azimuthGridDeg')!);
    await settle();
    expect(stored().azimuthGridDeg!.value).toBeCloseTo(269.9, 9);
    expect(stored().azimuthGridDeg!.basis).toBe('user');
    expect(input('azimuthGridDeg')!.value).toBe('271');
  });

  it('a true azimuth of 0 or 360 wraps round through grid and back', async () => {
    load(unit({ convergenceDeg: 1.1 }));
    show();
    type(input('azimuthGridDeg')!, '360');
    enter(input('azimuthGridDeg')!);
    await settle();
    expect(stored().azimuthGridDeg!.value).toBeCloseTo(358.9, 9);
    expect(input('azimuthGridDeg')!.value).toBe('0');
    // 0 is what it already shows: nothing more is written
    type(input('azimuthGridDeg')!, '0');
    enter(input('azimuthGridDeg')!);
    await settle();
    expect(h.writes).toBe(1);
  });

  it('a dish has no downtilt input', () => {
    load(unit({ kind: 'dish' }));
    show();
    expect(input('downtiltDeg')).toBeNull();
    expect(input('azimuthGridDeg')).not.toBeNull();
  });

  it('Reset to measured shows only for a typed value with a measured one and resets it', async () => {
    load(
      unit({
        azimuthGridDeg: typed(170),
        widthM: typed(0.5),
        measured: { azimuthGridDeg: measured(168) },
      }),
    );
    show();
    const reset = q('antenna-typed-reset-azimuthGridDeg')!;
    expect(reset.textContent).toContain('Reset to measured');
    // typed with nothing measured behind it, and measured values, offer no reset
    expect(q('antenna-typed-reset-widthM')).toBeNull();
    expect(q('antenna-typed-reset-heightM')).toBeNull();
    act(() => {
      reset.click();
    });
    await settle();
    expect(stored().azimuthGridDeg).toEqual(measured(168));
    expect(stored().measured).toBeUndefined();
    expect(input('azimuthGridDeg')!.value).toBe('168');
    expect(q('antenna-typed-reset-azimuthGridDeg')).toBeNull();
  });

  it('Reset to measured is hidden on a not-measured unit', () => {
    load({ ...notMeasured(), azimuthGridDeg: typed(90), widthM: typed(0.4) });
    show();
    expect(mount.querySelector('[data-testid^="antenna-typed-reset-"]')).toBeNull();
  });

  it('read-only: inputs are disabled and reset writes nothing', async () => {
    load(unit({ azimuthGridDeg: typed(170), measured: { azimuthGridDeg: measured(168) } }), true);
    show();
    expect(input('azimuthGridDeg')!.disabled).toBe(true);
    const reset = q('antenna-typed-reset-azimuthGridDeg')!;
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      reset.click();
    });
    await settle();
    expect(stored().azimuthGridDeg).toEqual(typed(170));
    expect(h.writes).toBe(0);
  });
});

describe('AntennaTypedField compact (a row cell)', () => {
  function Cell({ k }: { k: 'azimuthGridDeg' | 'downtiltDeg' }) {
    const u = useAntennas((s) => s.file?.units[0]);
    return u ? (
      <AntennaTypedField unit={u} fieldKey={k} readOnly={false} compact testId="cell" />
    ) : null;
  }
  const cell = () => q('cell') as HTMLInputElement;
  const showCell = (k: 'azimuthGridDeg' | 'downtiltDeg' = 'azimuthGridDeg') => {
    act(() => {
      root.render(<Cell k={k} />);
    });
  };

  it('is one input named by its label, with no visible label or reset', () => {
    load(unit({ azimuthGridDeg: typed(170), measured: { azimuthGridDeg: measured(168) } }));
    showCell();
    expect(cell().tagName).toBe('INPUT');
    expect(cell().getAttribute('aria-label')).toBe('Azimuth, project north (°)');
    expect(cell().value).toBe('170');
    expect(mount.querySelector('label')).toBeNull();
    expect(mount.querySelector('[data-testid^="antenna-typed-reset-"]')).toBeNull();
  });

  it('saves on Enter and blur once, as the fold does', async () => {
    load(unit());
    showCell();
    type(cell(), '172.5');
    enter(cell());
    blur(cell());
    await settle();
    expect(stored().azimuthGridDeg).toEqual(typed(172.5));
    expect(h.writes).toBe(1);
    expect(cell().value).toBe('172.5');
  });

  it('Esc puts the shown value back and writes nothing', async () => {
    load(unit());
    showCell('downtiltDeg');
    type(cell(), '9');
    act(() => {
      cell().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(cell().value).toBe('2');
    blur(cell());
    await settle();
    expect(h.writes).toBe(0);
  });

  it('an out-of-range entry marks the cell and says the range to a screen reader', async () => {
    load(unit());
    showCell('downtiltDeg');
    type(cell(), '120');
    enter(cell());
    await settle();
    expect(cell().getAttribute('aria-invalid')).toBe('true');
    const msg = mount.querySelector(`[id="${cell().getAttribute('aria-describedby') ?? ''}"]`)!;
    expect(msg.textContent).toContain('Enter a number from');
    expect(h.writes).toBe(0);
  });
});
