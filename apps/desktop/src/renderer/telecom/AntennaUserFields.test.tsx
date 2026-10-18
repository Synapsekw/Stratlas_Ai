// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaUserFields, type AntennaUserFieldsProps } from './AntennaUserFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const measured = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured', residualM: 0.003, support: 812, coverage: 0.74 },
});
function unit(over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id: 'ant-1',
    name: 'A1',
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'draft',
    box: {
      centre: [10.5, 20.25, 31.5],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.3, 1.2, 0.15],
    },
    support: 100,
    azimuthGridDeg: measured(123.4),
    downtiltDeg: measured(4),
    plumbDeg: measured(-0.5),
    widthM: measured(0.3),
    heightM: measured(1.2),
    depthM: measured(0.15),
    convergenceDeg: 1.2,
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
});
function show(u: AntennaUnit, p: Partial<AntennaUserFieldsProps> = {}) {
  const h = { onPatchUser: vi.fn() };
  act(() => {
    root.render(<AntennaUserFields unit={u} readOnly={false} {...h} {...p} />);
  });
  return h;
}
const input = (label: string): HTMLInputElement => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent.startsWith(label));
  return l!.querySelector('input')!;
};
function type(el: HTMLInputElement, value: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const blur = (el: HTMLElement) => {
  act(() => {
    el.focus();
    el.blur();
  });
};

describe('AntennaUserFields', () => {
  it('saves a model on blur and refuses a negative weight', () => {
    const h = show(unit());
    type(input('Model'), 'XYZ-1');
    blur(input('Model'));
    expect(h.onPatchUser).toHaveBeenCalledWith({ model: 'XYZ-1' });
    h.onPatchUser.mockClear();

    type(input('Weight'), '-3');
    blur(input('Weight'));
    expect(h.onPatchUser).not.toHaveBeenCalled();
    expect(input('Weight').getAttribute('aria-invalid')).toBe('true');
    const err = host.querySelector('#antenna-weight-err');
    expect(err?.textContent).toBe('Enter a weight in kilograms, 0 or more');
    expect(input('Weight').getAttribute('aria-describedby')).toBe('antenna-weight-err');
    type(input('Weight'), '501');
    blur(input('Weight'));
    expect(h.onPatchUser).not.toHaveBeenCalled();

    type(input('Weight'), '12.5');
    blur(input('Weight'));
    expect(h.onPatchUser).toHaveBeenCalledWith({ weightKg: 12.5 });
    expect(input('Weight').getAttribute('aria-invalid')).toBeNull();
    expect(host.querySelector('#antenna-weight-err')).toBeNull();
  });

  it('saves the in-service flag on change', () => {
    const h = show(unit());
    act(() => {
      input('In service').click();
    });
    expect(h.onPatchUser).toHaveBeenCalledWith({ active: true });
  });

  it('disables the inputs when read-only', () => {
    show(unit(), { readOnly: true });
    expect(input('Model').disabled).toBe(true);
    expect(input('Weight').disabled).toBe(true);
    expect(input('Frequencies').disabled).toBe(true);
    expect(input('In service').disabled).toBe(true);
  });

  it('shows the new unit values when the unit changes and does not patch on blur', () => {
    const h = show(unit({ user: { model: 'OLD', frequencies: 'f-old', weightKg: 9 } }));
    expect(input('Model').value).toBe('OLD');
    act(() => {
      root.render(
        <AntennaUserFields
          unit={unit({ id: 'ant-2', name: 'A2', user: { model: 'NEW' } })}
          readOnly={false}
          {...h}
        />,
      );
    });
    expect(input('Model').value).toBe('NEW');
    expect(input('Frequencies').value).toBe('');
    expect(input('Weight').value).toBe('');
    blur(input('Model'));
    blur(input('Frequencies'));
    blur(input('Weight'));
    expect(h.onPatchUser).not.toHaveBeenCalled();
  });
});
