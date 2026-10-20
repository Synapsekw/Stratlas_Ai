// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportFormatDialog, type ExportChoice } from './ExportFormatDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type F = 'dxf-all' | 'dxf-current' | 'csv' | 'png';
const CHOICES: ExportChoice<F>[] = [
  { format: 'dxf-all', label: 'All surfaces', group: 'DXF' },
  { format: 'dxf-current', label: 'Current survey only', group: 'DXF' },
  { format: 'csv', label: 'Elevations by chainage', group: 'CSV' },
  { format: 'png', label: 'Chart image', group: 'PNG' },
];

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

function mount(p: { initial?: F; onExport?: (f: F) => void; onClose?: () => void }) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <ExportFormatDialog
        title="Export section"
        choices={CHOICES}
        initial={p.initial ?? 'dxf-all'}
        onExport={p.onExport ?? vi.fn()}
        onClose={p.onClose ?? vi.fn()}
      />,
    ),
  );
  return document.body;
}

describe('ExportFormatDialog', () => {
  it('groups DXF choices and exports the picked one', () => {
    const onExport = vi.fn();
    const h = mount({ onExport });
    const groups = Array.from(h.querySelectorAll('[role="radiogroup"]'));
    expect(groups).toHaveLength(3);
    expect(groups[0]?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(h.querySelector<HTMLInputElement>('input[value="dxf-all"]')?.checked).toBe(true);
    act(() => h.querySelector<HTMLInputElement>('input[value="dxf-current"]')?.click());
    act(() => h.querySelector<HTMLButtonElement>('[data-testid="export-go"]')?.click());
    expect(onExport).toHaveBeenCalledWith('dxf-current');
  });

  it('keeps one selection across groups and closes on Escape', () => {
    const onExport = vi.fn();
    const onClose = vi.fn();
    const h = mount({ onExport, onClose });
    act(() => h.querySelector<HTMLInputElement>('input[value="png"]')?.click());
    expect(h.querySelector<HTMLInputElement>('input[value="dxf-all"]')?.checked).toBe(false);
    act(() => h.querySelector<HTMLButtonElement>('[data-testid="export-go"]')?.click());
    expect(onExport).toHaveBeenCalledWith('png');
    act(() => {
      h.querySelector('input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });
});
