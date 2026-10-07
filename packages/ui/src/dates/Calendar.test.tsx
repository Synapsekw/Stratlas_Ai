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
  it('arrow keys move between days and Enter picks a survey day', () => {
    const { onPick } = render('sep');
    q('cal-day-2024-09-04')?.focus();
    act(() => {
      q('calendar')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith('sep');
  });
});
