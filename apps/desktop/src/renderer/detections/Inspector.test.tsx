// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  finish: null as null | ((cls: { id: string }) => void),
  createResult: Promise.resolve(null),
}));

vi.mock('@aio/annotate', () => ({
  NEW_CLASS_OPTION: '__new-class__',
  SeverityBadge: () => null,
  useNewClass: () => ({ create: () => Promise.resolve({}), disabledReason: null }),
  useTaxonomy: () => ({
    classes: [],
    classById: new Map(),
    modelById: new Map(),
    models: [],
  }),
  NewClassRow: (p: { onCreated: (c: { id: string }) => void }) => {
    h.finish = p.onCreated;
    return <div data-testid="det-new-class" />;
  },
}));
vi.mock('./createFromLabel', () => ({ createClassFromLabel: () => h.createResult }));

const { Inspector } = await import('./Inspector');

/** Set a select's value the way React notices it, then fire change. */
const choose = (el: HTMLSelectElement, value: string) => {
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = desc?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

const det = (id: string, label?: string): Detection =>
  ({
    id,
    pass: 'review.json',
    source: 'ai',
    size: [1, 1],
    geom: { kind: 'box', box: [0, 0, 1, 1] },
    classId: '',
    label,
    severity: null,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'pass' },
  }) as unknown as Detection;

const props = (d: Detection, onPatch: (p: unknown) => void) => ({
  detection: d,
  position: { index: 0, total: 2 },
  issues: [],
  readOnly: false,
  problem: null,
  issueError: null,
  linking: false,
  noteFocus: 0,
  maskAssist: false,
  onPatch,
  onAccept: () => undefined,
  onLinkStart: () => undefined,
  onLinkCancel: () => undefined,
  onLink: () => undefined,
  onReject: () => undefined,
  onReopen: () => undefined,
  onDelete: () => undefined,
  onOpenIssue: () => undefined,
  onMask: () => undefined,
  onStep: () => undefined,
});

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  h.finish = null;
});
afterEach(() => {
  host.remove();
});

describe('Inspector new class state', () => {
  it('closes the row and drops the error when the detection changes', async () => {
    const root = createRoot(host);
    const patches: unknown[] = [];
    h.createResult = Promise.resolve('Classes not saved: disk full');
    await act(async () => {
      await Promise.resolve();
      root.render(<Inspector {...props(det('a', 'rust'), (p) => patches.push(p))} />);
    });
    const select = host.querySelector<HTMLSelectElement>('[data-testid="det-class"]');
    expect(select).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
      // the option exists only when a creator is registered
      const opt = host.querySelector<HTMLOptionElement>('option[value="__new-class__"]');
      expect(opt).not.toBeNull();
      if (select) {
        choose(select, '__new-class__');
      }
    });
    expect(host.querySelector('[data-testid="det-new-class"]')).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
      host.querySelector<HTMLButtonElement>('[data-testid="det-create-class"]')?.click();
    });
    expect(host.textContent).toContain('Classes not saved: disk full');

    await act(async () => {
      await Promise.resolve();
      root.render(<Inspector {...props(det('b', 'crack'), (p) => patches.push(p))} />);
    });
    expect(host.querySelector('[data-testid="det-new-class"]')).toBeNull();
    expect(host.textContent).not.toContain('Classes not saved');
    root.unmount();
  });

  it('does not apply a create that finishes after the detection changed', async () => {
    const root = createRoot(host);
    const patches: unknown[] = [];
    await act(async () => {
      await Promise.resolve();
      root.render(<Inspector {...props(det('a', 'rust'), (p) => patches.push(p))} />);
    });
    const select = host.querySelector<HTMLSelectElement>('[data-testid="det-class"]');
    await act(async () => {
      await Promise.resolve();
      if (select) {
        choose(select, '__new-class__');
      }
    });
    const finish = h.finish;
    expect(finish).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
      root.render(<Inspector {...props(det('b', 'crack'), (p) => patches.push(p))} />);
    });
    await act(async () => {
      await Promise.resolve();
      finish?.({ id: 'new' });
    });
    expect(patches).toEqual([]);
    root.unmount();
  });
});
