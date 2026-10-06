// @vitest-environment jsdom
import type { ProcModel } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitQuality, ModelBuilder, type ModelBuilderProps } from './ModelBuilder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model: ProcModel = {
  schema: 'aio.procmodel/1',
  id: 'site-model',
  name: 'Site model',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  parts: [
    {
      kind: 'cylinder',
      id: 'p1',
      tag: 'T-101',
      class: 'tank',
      status: 'draft',
      origin: { by: 'drawing', layer: 'TANKS' },
      base: [0, 0, 0],
      radius: 6,
      height: 12.5,
    },
    {
      kind: 'box',
      id: 'p2',
      class: 'skid',
      status: 'draft',
      confidence: 0.9,
      origin: { by: 'fit', residualM: 0.012, inliers: 900, inlierShare: 0.93 },
      base: [10, 0, 0],
      size: [6, 2, 3],
    },
  ],
};

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

function render(over: Partial<ModelBuilderProps> = {}) {
  const props: ModelBuilderProps = {
    model,
    models: [],
    readOnly: false,
    selected: null,
    busy: null,
    error: null,
    notice: null,
    drawings: [{ stem: 'plot', name: 'plot.dxf' }],
    clouds: [{ id: 'scan', name: 'Modelling scan' }],
    cloudDrawings: false,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onOpenModel: vi.fn(),
    onStatus: vi.fn(),
    onDimension: vi.fn(),
    onText: vi.fn(),
    onImport: vi.fn(),
    onPlace: vi.fn(),
    onFromDrawing: vi.fn(),
    onFromCloud: vi.fn(),
    onPreview: vi.fn(),
    onBuild: vi.fn(),
    onCloudDrawings: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ModelBuilder {...props} />);
  });
  return { props, el: host };
}

const button = (el: HTMLElement, text: string) => {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
};

describe('ModelBuilder', () => {
  it('lists the parts with status, size and origin', () => {
    const { el } = render();
    const items = [...el.querySelectorAll('[role="option"]')].map((x) => x.textContent);
    expect(items[0]).toContain('T-101');
    expect(items[0]).toContain('Cylinder, radius 6.0 m, height 12.5 m');
    expect(items[0]).toContain('From drawing, TANKS');
    expect(items[1]).toContain('Fitted, 1.2 cm off');
    expect(items[1]).toContain('90% sure');
    expect(button(el, 'Build model').disabled).toBe(true);
  });

  it('accepts and rejects with the keyboard, and all drafts at once', () => {
    const onStatus = vi.fn();
    const onSelect = vi.fn();
    const { el } = render({ selected: 'p1', onStatus, onSelect });
    const list = el.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('no list');
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true }));
    });
    expect(onStatus).toHaveBeenNthCalledWith(1, ['p1'], 'accepted');
    expect(onStatus).toHaveBeenNthCalledWith(2, ['p1'], 'rejected');
    expect(onSelect).toHaveBeenCalledWith('p2');
    expect(onStatus).toHaveBeenNthCalledWith(3, 'all', 'accepted');
    act(() => {
      button(el, 'Accept all drafts').click();
    });
    expect(onStatus).toHaveBeenLastCalledWith(['p1', 'p2'], 'accepted');
  });

  it('edits a dimension of the selected part', () => {
    const onDimension = vi.fn();
    const { el } = render({ selected: 'p1', onDimension });
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Height (m)"]');
    if (!input) throw new Error('no height');
    expect(input.value).toBe('12.5');
    act(() => {
      // React tracks the value setter: call the native one so onChange fires
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '14');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onDimension).toHaveBeenCalledWith('p1', 'height', 14);
  });

  it('runs the sources and keeps a package read only', () => {
    const onFromDrawing = vi.fn();
    const onFromCloud = vi.fn();
    const { el } = render({ onFromDrawing, onFromCloud });
    act(() => {
      button(el, 'From drawing').click();
      button(el, 'From point cloud').click();
    });
    expect(onFromDrawing).toHaveBeenCalledWith('plot');
    expect(onFromCloud).toHaveBeenCalledWith('scan');
    act(() => {
      root?.unmount();
    });
    host?.remove();
    const ro = render({ readOnly: true });
    expect(button(ro.el, 'From drawing').disabled).toBe(true);
    expect(ro.el.textContent).toContain('read-only package');
  });

  it('rates the fit residual', () => {
    const [tank, box] = model.parts;
    if (!tank || !box) throw new Error('parts');
    expect(fitQuality(box)).toEqual({
      label: '1.2 cm',
      tone: 'good',
    });
    expect(fitQuality(tank)).toBeNull();
  });
});
