// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRf, rfStore } from '../rfStore';
import { StepAntennas } from './StepAntennas';

vi.mock('../../shell', () => ({ bridge: { call: vi.fn() }, jobs: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const byTest = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const render = (accepted: number, drafts: number) => {
  const onReview = vi.fn();
  root = createRoot(host);
  act(() => root?.render(<StepAntennas accepted={accepted} drafts={drafts} onReview={onReview} />));
  return onReview;
};

beforeEach(() => {
  resetRf();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('StepAntennas', () => {
  it('counts accepted and draft units and links to the inventory', () => {
    const onReview = render(3, 1);
    const step = byTest('rf-step-antennas');
    expect(step?.textContent).toContain('Antennas');
    expect(step?.textContent).toContain('3 accepted · 1 draft');
    expect(step?.getAttribute('data-done')).toBe('true');
    act(() => byTest('rf-step-review')?.click());
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('says drafts in the plural and is not done with no unit taking part', () => {
    render(0, 2);
    const step = byTest('rf-step-antennas');
    expect(step?.textContent).toContain('0 accepted · 2 drafts');
    expect(step?.getAttribute('data-done')).toBe('false');
  });

  it('the include drafts switch sets the store and counts the drafts in', () => {
    render(0, 2);
    const sw = document.querySelector<HTMLElement>(
      '[data-testid="rf-step-antennas"] [role="switch"]',
    );
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    act(() => sw?.click());
    expect(rfStore.getState().includeUnreviewed).toBe(true);
    expect(byTest('rf-step-antennas')?.getAttribute('data-done')).toBe('true');
  });
});
