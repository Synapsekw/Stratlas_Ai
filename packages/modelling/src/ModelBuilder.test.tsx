// @vitest-environment jsdom
import type { ProcModel } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentsPanel } from './ComponentsSection';
import { stackModel } from './engineer/fixtures';
import { fitQuality, ModelBuilder, type ModelBuilderProps } from './ModelBuilder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model: ProcModel = {
  schema: 'aio.procmodel/2',
  materials: [],
  assemblies: [],
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

  it('reviews the selected part with its buttons; a list option holds no buttons', () => {
    const onStatus = vi.fn();
    const { el } = render({ selected: 'p1', onStatus });
    expect(el.querySelectorAll('[role="option"] button')).toHaveLength(0);
    const accept = el.querySelector<HTMLButtonElement>('button[aria-label="Accept T-101"]');
    expect(accept).not.toBeNull();
    expect(button(el, 'Make draft').disabled).toBe(true);
    act(() => {
      accept?.click();
      button(el, 'Reject').click();
    });
    expect(onStatus).toHaveBeenNthCalledWith(1, ['p1'], 'accepted');
    expect(onStatus).toHaveBeenNthCalledWith(2, ['p1'], 'rejected');
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

  describe('Components', () => {
    const eng = stackModel();
    const panel = (over: Partial<ComponentsPanel> = {}): ComponentsPanel => ({
      selected: 'flue-1',
      hidden: [],
      thumbnails: {},
      sourceVisible: true,
      modelVisible: true,
      unresolved: [],
      conflicts: [],
      report: null,
      stale: false,
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onStatus: vi.fn(),
      onRemove: vi.fn(),
      onAdd: vi.fn(),
      onField: vi.fn(),
      onFocus: vi.fn(),
      onSourceVisible: vi.fn(),
      onModelVisible: vi.fn(),
      onRebuild: vi.fn(),
      ...over,
    });

    it('shows the section only for a model with components', () => {
      const none = render({ components: panel() });
      expect(none.el.querySelector('[data-testid="components-section"]')).toBeNull();
      act(() => {
        root?.unmount();
      });
      host?.remove();
      const yes = render({ model: eng, components: panel() });
      expect(yes.el.querySelector('[data-testid="components-section"]')).not.toBeNull();
      expect(yes.el.querySelector('[data-testid="component-card"]')).not.toBeNull();
      act(() => {
        root?.unmount();
      });
      host?.remove();
      const bare = render({ model: eng });
      expect(bare.el.querySelector('[data-testid="components-section"]')).toBeNull();
    });

    it('shows what is unresolved and the photos that may show another asset', () => {
      const { el } = render({
        model: eng,
        components: panel({
          unresolved: ['The scale is assumed.', 'No view of the back.'],
          conflicts: [
            { imageIds: ['img-photo-aa'], reason: 'These photos share no colours with the rest.' },
          ],
        }),
      });
      expect(el.querySelector('[data-testid="unresolved"]')?.textContent).toContain(
        'No view of the back.',
      );
      const c = el.querySelector('[data-testid="conflicts"]');
      expect(c?.getAttribute('role')).toBe('alert');
      expect(c?.textContent).toContain('img-photo-aa');
    });

    it('never hides what the model file check left out or simplified', () => {
      const { el } = render({
        model: eng,
        components: panel({
          report: {
            failed: [{ id: 'duct-1', reason: 'The path has a zero-length segment.' }],
            simplified: [{ id: 'lattice-1', detail: 'fast' }],
            overBudget: true,
            notes: ['A finer mesh failed; the coarser one is kept.'],
          },
        }),
      });
      const r = el.querySelector('[data-testid="build-report"]');
      expect(r?.getAttribute('role')).toBe('alert');
      expect(r?.textContent).toContain('duct-1');
      expect(r?.textContent).toContain('zero-length');
      expect(r?.textContent).toContain('lattice-1, now fast');
      expect(r?.textContent).toContain('still over the size limit');
      expect(r?.textContent).toContain('the coarser one is kept');
      act(() => {
        root?.unmount();
      });
      host?.remove();
      const ok = render({
        model: eng,
        components: panel({ report: { failed: [], simplified: [], overBudget: false, notes: [] } }),
      });
      expect(ok.el.querySelector('[data-testid="build-report"]')?.textContent).toContain(
        'Every component was written to the file.',
      );
    });

    it('toggles the scan and the model, and rebuilds only when edits are waiting', () => {
      const p = panel({ stale: true });
      const { el } = render({ model: eng, components: p });
      const boxes = [
        ...el.querySelectorAll<HTMLInputElement>(
          '[data-testid="components-section"] > .mb-row input[type="checkbox"]',
        ),
      ];
      act(() => {
        boxes[0]?.click();
        boxes[1]?.click();
      });
      expect(p.onSourceVisible).toHaveBeenCalledWith(false);
      expect(p.onModelVisible).toHaveBeenCalledWith(false);
      act(() => {
        button(el, 'Rebuild with my edits').click();
      });
      expect(p.onRebuild).toHaveBeenCalled();
      act(() => {
        root?.unmount();
      });
      host?.remove();
      const idle = render({ model: eng, components: panel({ stale: false }) });
      expect(button(idle.el, 'Rebuild with my edits').disabled).toBe(true);
    });

    it('is locked with the panel when a job is busy', () => {
      const { el } = render({ model: eng, busy: 'Building', components: panel({ stale: true }) });
      expect(button(el, 'Rebuild with my edits').disabled).toBe(true);
      expect(button(el, 'Add component').disabled).toBe(true);
    });
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
