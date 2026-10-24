// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { emptyMeasurements, type SitePoint } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureStore } from '../../../../survey/measureStore';
import { measurementsGroup } from './MeasurementsGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../../survey/MeasurementPanel', () => ({
  MeasurementPanel: () => <div data-testid="panel-stub" />,
}));
vi.mock('../../../../survey/MeasureMenu', () => ({
  MeasureMenu: ({ at }: { at: { id: string } | null }) =>
    at ? <div data-testid="measure-menu" data-id={at.id} /> : null,
}));

let host: HTMLDivElement;
let root: Root;

const m = (id: string, label: string, to: number) => ({
  id,
  family: 'line' as const,
  tool: 'distance' as const,
  label,
  scope: { kind: 'site' as const },
  points: [
    [0, 0, 0],
    [to, 0, 0],
  ] as SitePoint[],
  items: [],
  results: [],
  createdAt: '2026-10-01T00:00:00.000Z',
});

function Probe() {
  const { Body } = measurementsGroup;
  return (
    <>
      <span data-testid="count">{measurementsGroup.useCount()}</span>
      <Body />
    </>
  );
}
const mount = () => {
  act(() => {
    root.render(<Probe />);
  });
};
const rows = () => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="project-measurement-row"]'),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  measureStore.setState({
    file: { ...emptyMeasurements(), measurements: [m('b', 'Kerb', 10), m('a', 'Apron', 4)] },
    selected: [],
    focus: null,
  });
  workspace.setState({ project: { id: 'p', root: '', manifest: {} } as never });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('measurementsGroup', () => {
  it('lists every measurement by name with its value', () => {
    mount();
    expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('2');
    expect(rows().map((r) => r.querySelector('.row-label')!.textContent)).toEqual([
      expect.stringMatching(/^Apron/),
      expect.stringMatching(/^Kerb/),
    ]);
    expect(rows()[1]!.querySelector('.row-count')!.textContent).toMatch(/10/);
  });

  it('a pick in the left tree selects the same row here', () => {
    mount();
    act(() => {
      measureStore.setState({ selected: ['b'], focus: 'b' });
    });
    expect(rows()[1]!.hasAttribute('data-selected')).toBe(true);
    expect(rows()[0]!.hasAttribute('data-selected')).toBe(false);
    act(() => {
      rows()[0]!.click();
    });
    expect(measureStore.getState().focus).toBe('a');
    expect(measurementsGroup.useSelected).toBeDefined();
  });

  it('shows the measurement panel inline under the focused row', () => {
    measureStore.setState({ selected: ['b'], focus: 'b' });
    mount();
    const side = host.querySelector('[data-testid="survey-side"]')!;
    expect(side.querySelector('[data-testid="panel-stub"]')).not.toBeNull();
    expect(side.closest('li')!.getAttribute('data-row-id')).toBe('b');
    expect(host.querySelectorAll('[data-testid="survey-side"]')).toHaveLength(1);
  });

  it('right-click gives the measurement actions', () => {
    mount();
    act(() => {
      rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="measure-menu"]')!.getAttribute('data-id')).toBe('a');
  });

  it('says so when there are none', () => {
    measureStore.setState({ file: emptyMeasurements() });
    mount();
    expect(host.textContent).toContain('No measurements yet');
  });
});
