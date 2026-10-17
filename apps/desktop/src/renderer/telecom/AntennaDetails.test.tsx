// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaDetails, type AntennaDetailsProps } from './AntennaDetails';

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
  vi.useRealTimers();
});
function show(u: AntennaUnit, p: Partial<AntennaDetailsProps> = {}) {
  const h = { onSetStatus: vi.fn(), onPatchUser: vi.fn(), onOpenPhoto: vi.fn() };
  act(() => {
    root.render(<AntennaDetails unit={u} projectId="p1" readOnly={false} {...h} {...p} />);
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

describe('AntennaDetails', () => {
  it('shows basis and quality for each value', () => {
    vi.useFakeTimers();
    show(unit());
    expect(host.textContent).toContain('True 124.6°');
    expect(host.textContent).toContain('Grid 123.4°');
    expect(host.textContent).toContain('Measured');
    expect(host.textContent).toContain('Mechanical tilt only');
    expect(host.textContent).toContain('31.50 m');
    expect(host.textContent).toContain('10.50, 20.25');
    const tipped = host.querySelector<HTMLElement>('dd [tabindex="0"]')!;
    act(() => {
      tipped.focus();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Fit residual 3.0 mm, 812 points, 74% coverage',
    );
  });

  it('shows Not measured for a missing plumb', () => {
    show(unit({ plumbDeg: undefined }));
    const dt = [...host.querySelectorAll('dt')].find((x) => x.textContent === 'Plumb')!;
    expect(dt.nextElementSibling?.textContent).toBe('Not measured');
  });

  it('shows elevation and diameter for dishes only', () => {
    show(unit({ kind: 'dish', elevationDeg: measured(5), diameterM: measured(0.6) }));
    expect(host.textContent).toContain('Elevation');
    expect(host.textContent).toContain('Diameter');
    expect(host.textContent).not.toContain('Downtilt');
    expect(host.textContent).not.toContain('Plumb');
  });

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

  it('opens the photo viewer from a thumbnail and builds the crop url', () => {
    const h = show(
      unit({
        crop: 'telecom/crops/ant-1.jpg',
        photos: [
          { layer: 'L1', id: 'p-a', score: 0.9 },
          { layer: 'L2', id: 'p-b', score: 0.5 },
        ],
      }),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe(
      'aio://project/p1/telecom/crops/ant-1.jpg',
    );
    const btns = [...host.querySelectorAll<HTMLElement>('[data-testid="antenna-photo"]')];
    expect(btns).toHaveLength(2);
    act(() => {
      btns[1]!.click();
    });
    expect(h.onOpenPhoto).toHaveBeenCalledWith('L2', 'p-b');
  });

  it('names the AI provider in the kind basis', () => {
    show(unit({ kindBasis: 'ai' }), { aiProvider: 'Claude' });
    expect(host.textContent).toContain('Type labelled by AI (Claude)');
  });

  it('sets status from the buttons', () => {
    const h = show(unit());
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="antenna-accept"]')!.click();
    });
    expect(h.onSetStatus).toHaveBeenCalledWith('accepted');
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="antenna-reject"]')!.click();
    });
    expect(h.onSetStatus).toHaveBeenCalledWith('rejected');
  });

  it('disables edits when read-only', () => {
    const h = show(unit(), { readOnly: true });
    expect(input('Model').disabled).toBe(true);
    expect(host.querySelector('[data-testid="antenna-accept"]')?.textContent).toContain(
      'Read-only package: review is not available',
    );
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="antenna-accept"]')!.click();
    });
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });
});
