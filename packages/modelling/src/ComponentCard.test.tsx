// @vitest-environment jsdom
import type { Assembly } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComponentCard,
  coverageWords,
  residualWords,
  type ComponentCardProps,
} from './ComponentCard';
import { newAssembly } from './assemblyEdit';
import { byId, must } from './engineer/assemble/testAssemble';
import { stackModel } from './engineer/fixtures';
import { t } from '@aio/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

const model = stackModel();

/** A flue whose outer radius was measured (residual 1.2 cm, mostly seen), the rest as the fixture has it. */
function measuredFlue(): Assembly {
  const f = byId(model, 'flue-1');
  return {
    ...f,
    sources: [
      { kind: 'cloud', ref: 'scan-1', view: 'crown' },
      { kind: 'photo', ref: 'img-photo-aaaaaaaaaaaa', view: 'north' },
    ],
    unobserved: ['back', 'interior'],
    quality: {
      ...f.quality,
      rOuter: { basis: 'measured', residualM: 0.012, support: 400, coverage: 0.9 },
      height: { basis: 'user' },
      rInner: { basis: 'inferred' },
    },
  };
}

function render(over: Partial<ComponentCardProps> = {}) {
  const fns = { onField: vi.fn(), onFocus: vi.fn() };
  const props: ComponentCardProps = {
    assembly: measuredFlue(),
    evidence: { thumbnails: { 'img-photo-aaaaaaaaaaaa': 'data:image/png;base64,AAAA' } },
    ...fns,
    ...over,
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ComponentCard {...props} />);
  });
  return fns;
}

const html = () => must(host, 'host');

const row = (key: string) => must(html().querySelector<HTMLElement>(`[data-field="${key}"]`), key);
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = (el: Element, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

describe('ComponentCard', () => {
  it('shows individual dimensions and position and offers full-size source evidence', () => {
    const antenna = newAssembly(model, 'antenna');
    render({ assembly: { ...antenna, sources: measuredFlue().sources } });
    expect(row('size').textContent).toContain('Width / height / depth');
    expect(row('centre').textContent).toContain('project local X / Y / Z');
    expect(html().querySelector('button[aria-label="Enlarge source image"]')).not.toBeNull();
  });
  it('names the basis of each value in words', () => {
    render();
    expect(row('rOuter').textContent).toContain('Measured');
    expect(row('rInner').textContent).toContain('Inferred');
    expect(row('height').textContent).toContain('Entered by you');
    expect(row('rOuter').querySelector('[data-basis]')?.getAttribute('data-basis')).toBe(
      'measured',
    );
  });

  it('says how a measurement fits and how much was seen, in words, never a percentage', () => {
    render();
    const text = html().textContent;
    expect(row('rOuter').textContent).toContain('Fits the scan to about 1 cm');
    expect(row('rOuter').textContent).toContain('High coverage in the sampled region');
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\bsure\b|confidence/i);
    // the bands of both words
    const q = (coverage: number) =>
      coverageWords(t, { basis: 'measured', coverage, residualM: 0.01, support: 10 });
    expect([0.95, 0.7, 0.4, 0.1].map(q)).toEqual([
      'High coverage in the sampled region',
      'Moderate coverage in the sampled region',
      'Partial coverage in the sampled region',
      'Sparse coverage in the sampled region',
    ]);
    expect(residualWords(t, { basis: 'measured', residualM: 0.004, support: 9 })).toBe(
      'Fits the scan to under 1 cm',
    );
    expect(residualWords(t, { basis: 'inferred' })).toBeNull();
  });

  it('lists the evidence with thumbnails where it has them, and the surfaces nobody saw', () => {
    render();
    const items = [...html().querySelectorAll('.mb-cmp-sources li')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Scan');
    expect(items[0]?.querySelector('img')).toBeNull();
    const img = must(items[1]?.querySelector('img'));
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.getAttribute('alt')).toBe('Photo north');
    expect(html().textContent).toContain('Not seen: the back, the inside');
  });

  it('says so when no evidence is linked', () => {
    render({ assembly: { ...measuredFlue(), sources: [] } });
    expect(html().textContent).toContain('No evidence is linked to this component.');
  });

  it('labels a provisional scale, and a scale from a reference or the scan', () => {
    render({ evidence: { thumbnails: {}, scale: { status: 'provisional' } } });
    expect(must(html().querySelector('[data-scale="provisional"]')).textContent).toContain(
      'size is assumed',
    );
    act(() => {
      root?.unmount();
    });
    html().remove();
    render({
      evidence: {
        thumbnails: {},
        scale: { status: 'reference', reference: { what: 'height', valueM: 50 } },
      },
    });
    expect(html().textContent).toContain('Sized from the dimension you entered.');
    act(() => {
      root?.unmount();
    });
    html().remove();
    render({ evidence: { thumbnails: {}, scale: { status: 'measured' } } });
    expect(html().querySelector('[data-scale]')).toBeNull();
    expect(html().textContent).toContain('Sized from the scan.');
  });

  it('hands a typed value to the host, refuses one out of range, and edits flags and choices', () => {
    const p = render();
    const input = must(row('rOuter').querySelector<HTMLInputElement>('input[type="text"]'));
    type(input, '1.25');
    press(input, 'Enter');
    expect(p.onField).toHaveBeenCalledWith('rOuter', 1.25);
    const bad = must(row('height').querySelector<HTMLInputElement>('input[type="text"]'));
    type(bad, '-3');
    press(bad, 'Enter');
    expect(bad.getAttribute('aria-invalid')).toBe('true');
    expect(p.onField).toHaveBeenCalledTimes(1);
    const rim = must(row('rim').querySelector<HTMLInputElement>('input[type="checkbox"]'));
    act(() => {
      rim.click();
    });
    expect(p.onField).toHaveBeenLastCalledWith('rim', false);
  });

  it('offers named choices for an antenna and counts as whole numbers', () => {
    const antenna = newAssembly(model, 'antenna');
    const p = render({ assembly: antenna });
    const select = must(row('kind').querySelector<HTMLSelectElement>('select'));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        select,
        'dish',
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(p.onField).toHaveBeenCalledWith('kind', 'dish');
    act(() => {
      root?.unmount();
    });
    html().remove();
    const p2 = render({ assembly: newAssembly(model, 'lattice') });
    const legs = must(row('legs').querySelector<HTMLInputElement>('input[type="text"]'));
    type(legs, '3.5');
    press(legs, 'Enter');
    expect(p2.onField).not.toHaveBeenCalled();
    type(legs, '3');
    press(legs, 'Enter');
    expect(p2.onField).toHaveBeenCalledWith('legs', 3);
  });

  it('brings the component into view and is inert when locked', () => {
    const p = render({ locked: true });
    act(() => {
      must(
        [...html().querySelectorAll('button')].find((b) => b.textContent.includes('Show in view')),
      ).click();
    });
    expect(p.onFocus).toHaveBeenCalled();
    expect(html().querySelector('input[type="text"]')?.hasAttribute('disabled')).toBe(true);
  });
});
