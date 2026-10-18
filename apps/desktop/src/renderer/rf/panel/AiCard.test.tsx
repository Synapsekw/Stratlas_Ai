// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCard, type AiCardProps } from './AiCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const byTest = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = async () => {
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
};

const render = (over: Partial<AiCardProps> = {}) => {
  const props: AiCardProps = {
    onAutoplan: vi.fn(),
    onSetUpByHand: vi.fn(),
    onUseExport: vi.fn(),
    exportAvailable: false,
    readFile: (f) => Promise.resolve(`text of ${f.name}`),
    ...over,
  };
  root = createRoot(host);
  act(() => root?.render(<AiCard {...props} />));
  return props;
};

/** A drop of the given files on the card. */
const drop = (el: HTMLElement, files: File[]) => {
  const dataTransfer = { files, types: ['Files'], dropEffect: 'none' };
  act(() => {
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(over, { dataTransfer });
    el.dispatchEvent(over);
  });
  act(() => {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(ev, { dataTransfer });
    el.dispatchEvent(ev);
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('AiCard', () => {
  it('explains Auto-plan and offers Auto-plan & run, set up by hand and Use cell export', () => {
    const p = render();
    const card = byTest('rf-ai-card');
    expect(card?.textContent).toContain('Plan coverage with AI');
    expect(card?.textContent).toContain('You review it before anything is saved.');
    const run = byTest('rf-ai-autoplan');
    expect(run?.textContent).toContain('Auto-plan & run');
    expect(run?.className).toContain('primary');
    act(() => run?.click());
    expect(p.onAutoplan).toHaveBeenCalledOnce();
    act(() => byTest('rf-ai-by-hand')?.click());
    expect(p.onSetUpByHand).toHaveBeenCalledOnce();
    expect(byTest('rf-ai-export')?.textContent).toContain('Use cell export');
    expect(byTest('rf-ai-export')?.className).not.toContain('primary');
  });

  it('Use cell export is the main action once a group came from an export', () => {
    render({ exportAvailable: true });
    expect(byTest('rf-ai-export')?.className).toContain('primary');
    expect(byTest('rf-ai-autoplan')?.className).not.toContain('primary');
  });

  it('picking a file hands its text to onUseExport', async () => {
    const p = render();
    const input = byTest('rf-ai-export-file') as HTMLInputElement | null;
    expect(input?.accept).toBe('.csv,text/csv');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['a,b'], 'cells.csv', { type: 'text/csv' })],
    });
    act(() => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(p.onUseExport).toHaveBeenCalledWith('text of cells.csv');
  });

  it('dropping a .csv on the card does the same; another file is ignored', async () => {
    const p = render();
    const card = byTest('rf-ai-card');
    if (!card) throw new Error('no card');
    drop(card, [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await flush();
    expect(p.onUseExport).not.toHaveBeenCalled();
    drop(card, [new File(['a,b'], 'export.CSV')]);
    await flush();
    expect(p.onUseExport).toHaveBeenCalledWith('text of export.CSV');
  });

  it('disabled: no action runs', async () => {
    const p = render({ disabled: true });
    act(() => byTest('rf-ai-autoplan')?.click());
    expect(p.onAutoplan).not.toHaveBeenCalled();
    const card = byTest('rf-ai-card');
    if (!card) throw new Error('no card');
    drop(card, [new File(['a,b'], 'export.csv')]);
    await flush();
    expect(p.onUseExport).not.toHaveBeenCalled();
  });
});
