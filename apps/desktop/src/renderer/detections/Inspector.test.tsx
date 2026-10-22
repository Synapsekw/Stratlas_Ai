// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewCommand, type KeyLike } from './keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  finish: null as null | ((cls: { id: string }) => void),
  createResult: Promise.resolve<string | null>(null),
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

const draft = (over: Record<string, unknown> = {}): Detection =>
  ({
    ...det('m1', 'rust'),
    origin: {
      kind: 'model',
      producer: 'local',
      detector: { id: 'rust', version: 1, modelSha256: 'a'.repeat(64), threshold: 0.8 },
    },
    confidence: 0.62,
    ...over,
  }) as unknown as Detection;

describe('Inspector local detector drafts', () => {
  const menuItem = (label: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (i) => i.textContent === label,
    );

  it('shows the score badge against the pass bar', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<Inspector {...props(draft(), () => undefined)} threshold={0.8} />);
    });
    expect(host.querySelector('[data-testid="det-vlm-score"]')?.textContent).toBe(
      '0.62 · under threshold',
    );
    root.unmount();
  });

  it('shows no badge on a draft from anywhere else', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<Inspector {...props(det('a', 'rust'), () => undefined)} />);
    });
    expect(host.querySelector('[data-testid="det-vlm-score"]')).toBeNull();
    root.unmount();
  });

  it('reject on a detector draft opens the reason menu; Reject without a reason rejects with no reason', () => {
    const root = createRoot(host);
    const onReject = vi.fn();
    act(() => {
      root.render(<Inspector {...props(draft(), () => undefined)} onReject={onReject} />);
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="det-reject"]')?.click();
    });
    expect(onReject).not.toHaveBeenCalled();
    expect(menuItem('Not a defect')).toBeDefined();
    act(() => {
      menuItem('Reject without a reason')?.click();
    });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith();
    root.unmount();
  });

  it('passes the chosen reason on', () => {
    const root = createRoot(host);
    const onReject = vi.fn();
    act(() => {
      root.render(<Inspector {...props(draft(), () => undefined)} onReject={onReject} />);
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="det-reject"]')?.click();
    });
    act(() => {
      menuItem('Wrong class')?.click();
    });
    expect(onReject).toHaveBeenCalledWith('wrong-class', undefined);
    root.unmount();
  });

  it('rejects at once on any other draft', () => {
    const root = createRoot(host);
    const onReject = vi.fn();
    act(() => {
      root.render(<Inspector {...props(det('a', 'rust'), () => undefined)} onReject={onReject} />);
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="det-reject"]')?.click();
    });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    root.unmount();
  });

  it('the reject key still rejects at once, with no menu', () => {
    // the screen handles the key, not the inspector: it maps to a plain reject command
    expect(
      reviewCommand({
        key: 'x',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      } satisfies KeyLike),
    ).toEqual({ kind: 'reject' });
  });
});
