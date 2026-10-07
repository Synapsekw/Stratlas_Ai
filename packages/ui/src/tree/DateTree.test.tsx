// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateTag } from '@aio/workspace';
import { DateTree } from './DateTree';
import type { DateFolder } from './dateModel';
import type { TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = (ids: string[]): TreeGroup => ({
  kind: 'models',
  label: 'Models',
  icon: 'scene',
  count: ids.length,
  items: ids.map((id) => ({ id, layerId: id, layerKind: 'mesh', name: id })),
});
const cap = (id: string, date: string) => ({ id, label: id, date });
const folders: DateFolder[] = [
  {
    id: 'every',
    capture: null,
    label: 'Every date',
    groups: [group(['site'])],
    layerIds: ['site'],
  },
  {
    id: 'nov',
    capture: cap('nov', '2024-11-06'),
    label: '6 Nov 2024',
    groups: [group(['m-nov'])],
    layerIds: ['m-nov'],
  },
  {
    id: 'oct',
    capture: cap('oct', '2024-10-02'),
    label: '2 Oct 2024',
    groups: [group(['m-oct'])],
    layerIds: ['m-oct'],
  },
  { id: 'sep', capture: cap('sep', '2024-09-04'), label: '4 Sep 2024', groups: [], layerIds: [] },
];
const tags: Record<string, DateTag> = {
  sep: {
    id: 'sep',
    date: '2024-09-04',
    order: 0,
    colour: 'var(--date-1)',
    short: '4 Sep',
    long: '4 Sep 2024',
  },
  oct: {
    id: 'oct',
    date: '2024-10-02',
    order: 1,
    colour: 'var(--date-2)',
    short: '2 Oct',
    long: '2 Oct 2024',
  },
  nov: {
    id: 'nov',
    date: '2024-11-06',
    order: 2,
    colour: 'var(--date-3)',
    short: '6 Nov',
    long: '6 Nov 2024',
  },
};

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

function render(focus: string, hidden: Record<string, true>, onFocus = vi.fn()) {
  const root = createRoot(host);
  const props = {
    folders,
    tags,
    focus,
    onFocus,
    hidden,
    selectedId: null,
    activeClip: null,
    onToggleVisible: vi.fn(),
    onSetVisible: vi.fn(),
    onSelect: vi.fn(),
  };
  act(() => {
    root.render(<DateTree {...props} />);
  });
  return { root, props, onFocus };
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('DateTree', () => {
  it('expands only the focused date and marks it current', () => {
    render('nov', { 'm-oct': true });
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('false');
    expect(q('date-name-nov')?.getAttribute('aria-current')).toBe('date');
  });

  it('clicking a date name focuses it', () => {
    const { onFocus } = render('nov', {});
    act(() => {
      (q('date-name-oct') as HTMLButtonElement).click();
    });
    expect(onFocus).toHaveBeenCalledWith('oct');
  });

  it('collapses other dates when focus changes', () => {
    const { root, props } = render('nov', {});
    act(() => {
      root.render(<DateTree {...props} focus="oct" />);
    });
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the count of visible layers on a collapsed non-focused date', () => {
    render('nov', {}); // m-oct visible = extra
    expect(q('date-on-oct')?.textContent).toBe('1 on');
    expect(q('date-on-nov')).toBeNull();
  });

  it('greys an empty date', () => {
    render('nov', {});
    expect(q('date-folder-sep')?.className).toContain('empty');
  });
});
