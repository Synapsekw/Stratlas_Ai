// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Calendar, type CalendarDay } from './Calendar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const days: CalendarDay[] = [
  { id: 'sep', date: '2024-09-04', colour: 'var(--date-1)', label: '4 Sep 2024', count: 6 },
  { id: 'nov', date: '2024-11-06', colour: 'var(--date-2)', label: '6 Nov 2024', count: 9 },
  { id: 'nov-b', date: '2024-11-06', colour: 'var(--date-3)', label: '6 Nov 2024', count: 2 },
];
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function render(focusId: string | null, onPick = vi.fn(), onClose = vi.fn()) {
  root = createRoot(host);
  act(() =>
    root?.render(<Calendar days={days} focusId={focusId} onPick={onPick} onClose={onClose} />),
  );
  return { onPick, onClose };
}

function press(key: string) {
  act(() => {
    q('calendar')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}
const active = () => document.activeElement?.getAttribute('data-date');

describe('Calendar', () => {
  it('opens on the focused month and skips months without surveys', () => {
    render('sep');
    expect(q('cal-month')?.textContent).toContain('2024');
    expect(q('cal-day-2024-09-04')).not.toBeNull();
    act(() => q('cal-next')?.click());
    expect(q('cal-day-2024-11-06')).not.toBeNull(); // October skipped
  });
  it('picks a single-survey day', () => {
    const { onPick } = render('sep');
    act(() => q('cal-day-2024-09-04')?.click());
    expect(onPick).toHaveBeenCalledWith('sep');
  });
  it('lists surveys when a day has more than one', () => {
    const { onPick } = render('nov');
    act(() => q('cal-day-2024-11-06')?.click());
    const options = host.querySelectorAll('[data-testid^="cal-choice-"]');
    expect(options).toHaveLength(2);
    act(() => {
      (options[1] as HTMLElement).click();
    });
    expect(onPick).toHaveBeenCalledWith('nov-b');
  });
  it('Escape closes', () => {
    const { onClose } = render('nov');
    act(() => {
      q('calendar')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
  it('focuses the current survey day on mount', () => {
    render('sep');
    expect(document.activeElement?.getAttribute('data-date')).toBe('2024-09-04');
    expect(q('cal-month')?.textContent).toBe('September 2024');
  });
  it('Enter picks a survey day', () => {
    const { onPick } = render('sep');
    press('Enter');
    expect(onPick).toHaveBeenCalledWith('sep');
  });
  it('arrows move onto days without a survey, and Enter there does nothing', () => {
    const { onPick } = render('sep');
    press('ArrowRight');
    expect(active()).toBe('2024-09-05');
    expect(q('cal-blank-2024-09-05')?.getAttribute('aria-disabled')).toBe('true');
    press('Enter');
    expect(onPick).not.toHaveBeenCalled();
    press('ArrowDown');
    expect(active()).toBe('2024-09-12');
    press('ArrowLeft');
    press('ArrowUp');
    expect(active()).toBe('2024-09-04');
  });
  it('keeps one tab stop that follows focus', () => {
    render('sep');
    const stops = () => host.querySelectorAll('.cal-day[tabindex="0"]');
    expect(stops()).toHaveLength(1);
    press('ArrowRight');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]?.getAttribute('data-date')).toBe('2024-09-05');
  });
  it('arrows cross a month boundary and keep focus inside the calendar', () => {
    const { onClose } = render('nov');
    for (let i = 0; i < 6; i += 1) press('ArrowLeft'); // 6 Nov back to 31 Oct
    expect(active()).toBe('2024-10-31');
    expect(q('cal-month')?.textContent).toBe('October 2024');
    expect(q('calendar')?.contains(document.activeElement)).toBe(true);
    press('Escape');
    expect(onClose).toHaveBeenCalled();
  });
  it('Page Down and Page Up step survey months, skipping October, and clamp', () => {
    render('sep');
    press('PageUp');
    expect(q('cal-month')?.textContent).toBe('September 2024');
    press('PageDown');
    expect(q('cal-month')?.textContent).toBe('November 2024');
    expect(active()).toBe('2024-11-06');
    press('PageDown');
    expect(q('cal-month')?.textContent).toBe('November 2024');
    press('PageUp');
    expect(q('cal-month')?.textContent).toBe('September 2024');
    expect(q('calendar')?.contains(document.activeElement)).toBe(true);
  });
  it('labels days with a pluralised layer count', () => {
    render('sep');
    expect(q('cal-day-2024-09-04')?.getAttribute('aria-label')).toBe(
      '4 Sep 2024, survey, 6 layers',
    );
  });
});
