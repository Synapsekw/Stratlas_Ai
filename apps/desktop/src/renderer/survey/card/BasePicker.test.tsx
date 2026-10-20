// @vitest-environment jsdom
import { defaultSurveySettings, type SurfaceRef, type SurveyMeasurement } from '@aio/schema';
import type { SideOption } from '@aio/survey';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../measureStore', () => ({
  useMeasure: (sel: (s: unknown) => unknown) => sel({ settings: defaultSurveySettings() }),
}));
vi.mock('../BaseEditor', () => ({
  BaseEditor: () => <div data-testid="base-editor" />,
}));

const { BasePicker, BASES, baseIdOf, baseName } = await import('./BasePicker');
const { t } = await import('@aio/ui');

const SURFACES: SideOption[] = [
  {
    key: 'current',
    label: 'Current survey',
    group: 'Surveys',
    note: '05 Oct',
    ref: { kind: 'current' },
  },
  {
    key: 'previous',
    label: 'Previous survey',
    group: 'Surveys',
    note: '01 Sep',
    ref: { kind: 'previous' },
  },
  {
    key: 'design:d1/l1',
    label: 'Pad design, Finished level',
    group: 'Designs',
    ref: { kind: 'design', design: 'd1', layer: 'l1' },
  },
  { key: 'smart', label: 'Smart', group: 'Bases', ref: { kind: 'smart' } },
];

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('no element');
  act(() => {
    (el as HTMLElement).click();
  });
};

const M: SurveyMeasurement = {
  id: 'm1',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile 7',
  scope: { kind: 'site' },
  points: [
    [0, 0, 10],
    [10, 0, 11],
    [10, 10, 12],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-05T00:00:00.000Z',
};

function picker(value: SurfaceRef, onChange = vi.fn(), readOnly = false) {
  mount(
    <BasePicker value={value} onChange={onChange} surfaces={SURFACES} readOnly={readOnly} m={M} />,
  );
  return onChange;
}

const open = () => {
  click(document.querySelector('[data-testid="survey-from"]'));
};
const rows = () => [...document.querySelectorAll('[role="menuitemradio"][data-base]')];

describe('BasePicker', () => {
  it('base picker lists seven bases with their one-line hints, Triangulated toe first', () => {
    picker({ kind: 'smart' });
    expect(document.querySelector('[data-testid="survey-from"]')?.textContent).toContain(
      'Base: Triangulated toe',
    );
    open();
    const list = rows();
    expect(list).toHaveLength(7);
    expect(BASES).toHaveLength(7);
    expect(list.map((r) => r.querySelector('.bp-name')?.textContent)).toEqual([
      'Triangulated toe',
      'Lowest point',
      'Best-fit plane',
      'Fixed level',
      'Average edge level',
      'Previous survey or design',
      'Custom',
    ]);
    expect(list[0]?.querySelector('.bp-hint')?.textContent).toBe(
      'the surveying norm for piles on uneven ground',
    );
    expect(list[1]?.querySelector('.bp-hint')?.textContent).toBe(
      'bins, bunkers, piles against walls',
    );
    expect(list[5]?.querySelector('.bp-hint')?.textContent).toBe(
      'the measured ground underneath, the most accurate when it exists',
    );
    for (const r of list) expect(r.querySelector('.bp-hint')?.textContent).not.toBe('');
    expect(list[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('maps Lowest point and Fixed level to reference modes', () => {
    const onChange = picker({ kind: 'smart' });
    open();
    click(rows()[1]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'reference', mode: 'perimeter-min' });
    open();
    click(rows()[3]);
    expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'reference', mode: 'level', levelM: 11 });
    open();
    click(rows()[2]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'fit-plane' });
    open();
    click(rows()[4]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'perimeter-mean' });
    expect(baseIdOf({ kind: 'reference', mode: 'perimeter-min' })).toBe('lowest');
    expect(baseIdOf({ kind: 'reference', mode: 'level', levelM: 3 })).toBe('level');
    expect(baseIdOf({ kind: 'previous' })).toBe('surface');
  });

  it('Previous survey or design opens the surface list', () => {
    const onChange = picker({ kind: 'smart' });
    open();
    const surface = rows()[5];
    expect(surface?.getAttribute('aria-expanded')).toBe('false');
    click(surface);
    expect(onChange).not.toHaveBeenCalled();
    const list = [
      ...document.querySelectorAll('[data-testid="bp-surfaces"] [role="menuitemradio"]'),
    ];
    // surveys and designs only: never the current survey, never a base
    expect(list.map((r) => r.textContent)).toEqual([
      'Previous survey (01 Sep)',
      'Pad design, Finished level',
    ]);
    click(list[1]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'design', design: 'd1', layer: 'l1' });
  });

  it('shows a surface base as From with its name', () => {
    picker({ kind: 'previous' });
    expect(document.querySelector('[data-testid="survey-from"]')?.textContent).toContain(
      'From: Previous survey (01 Sep)',
    );
  });

  it('a fixed level shows its level field and a custom base its editor', () => {
    picker({ kind: 'reference', mode: 'level', levelM: 101.5 });
    const input = document.querySelector<HTMLInputElement>('[data-testid="survey-ref-level"]');
    expect(input?.value).toBe('101.500');
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    picker({
      kind: 'custom',
      vertices: [
        { e: 0, n: 0, z: 1 },
        { e: 1, n: 0, z: 1 },
        { e: 1, n: 1, z: 1 },
      ],
    });
    expect(document.querySelector('[data-testid="base-editor"]')).not.toBeNull();
  });

  it("an older file's highest point reads plainly and shows as the ticked mode", () => {
    picker({ kind: 'reference', mode: 'perimeter-max' });
    expect(document.querySelector('[data-testid="survey-from"]')?.textContent).toContain(
      'Base: Highest point',
    );
    open();
    const older = document.querySelector('[role="menuitemradio"][data-base="older"]');
    expect(older?.getAttribute('aria-checked')).toBe('true');
    expect(older?.textContent).toBe('Highest point');
    // the seven bases follow, none ticked
    const list = rows().filter((r) => r.getAttribute('data-base') !== 'older');
    expect(list).toHaveLength(7);
    expect(list.some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false);
    expect(baseName({ kind: 'reference', mode: 'interior-min' }, SURFACES, t)).toBe(
      'Lowest point inside',
    );
    expect(baseName({ kind: 'reference', mode: 'interior-max' }, SURFACES, t)).toBe(
      'Highest point inside',
    );
  });

  it('a survey or design no longer in the project reads as missing, not by its id', () => {
    expect(baseName({ kind: 'survey', surface: 'gone-dsm' }, SURFACES, t)).toBe('Missing survey');
    expect(baseName({ kind: 'design', design: 'd9', layer: 'l9' }, SURFACES, t)).toBe(
      'Missing design',
    );
  });

  it('read-only: the chip does not open', () => {
    picker({ kind: 'smart' }, vi.fn(), true);
    const chip = document.querySelector<HTMLButtonElement>('[data-testid="survey-from"]');
    expect(chip?.disabled).toBe(true);
  });
});
