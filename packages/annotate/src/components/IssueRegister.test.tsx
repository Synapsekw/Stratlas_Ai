// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIssueView, issueView } from '../model/view';
import { issueEditor, setAnnotateReadOnly, setIssueListActions } from '../runtime';
import { catalogue, makeIssue, strictModel, tankModel } from '../testing';
import { IssueRegister } from './IssueRegister';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => undefined;
globalThis.ResizeObserver = class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
};

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'big',
  name: 'Big',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel, strictModel],
  classCatalogues: [catalogue],
};

const many = (n: number): Issue[] =>
  Array.from({ length: n }, (_, k) =>
    makeIssue({
      id: `i${k}`,
      code: `D${String(k).padStart(4, '0')}`,
      severity: ((k % 5) + 1) as Issue['severity'],
      classId: k % 2 ? 'crack' : 'blister',
      title: k % 3 ? `Bleeding at km ${k % 9}.1` : 'Longitudinal cracking',
    }),
  );

function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(<IssueRegister />);
  });
  const q = (sel: string) => el.querySelector(sel);
  return {
    el,
    q,
    rows: () => el.querySelectorAll('.ann-row').length,
    change: (label: string, value: string) => {
      const s = q(`select[aria-label="${label}"]`);
      if (!(s instanceof HTMLSelectElement)) throw new Error(`no select ${label}`);
      act(() => {
        s.value = value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
    },
    click: (sel: string, init?: MouseEventInit) => {
      const b = q(sel);
      if (!b) throw new Error(`no ${sel}`);
      act(() => {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      el.remove();
    },
  };
}

describe('IssueRegister at scale', () => {
  afterEach(() => {
    workspace.getState().closeProject();
  });

  it('renders only the rows in view for 2,115 issues', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(2115));
    const ui = mount();
    expect(ui.el.textContent).toContain('2115');
    expect(ui.rows()).toBeGreaterThan(5);
    expect(ui.rows()).toBeLessThan(60);
    ui.unmount();
  });

  it('groups by severity with headers that collapse', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(50));
    const ui = mount();
    ui.change('Group', 'severity');
    const heads = () => [...ui.el.querySelectorAll('.ann-group')].map((h) => h.textContent);
    expect(heads()[0]).toContain('Severity 5');
    expect(heads()[0]).toContain('10');
    const before = ui.rows();
    ui.click('.ann-group');
    expect(ui.rows()).toBeLessThan(before);
    ui.unmount();
  });

  it('sets the status of the checked issues in one step and undoes it', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(20));
    const ui = mount();
    ui.click('[data-tick="D0000"]');
    ui.click('[data-tick="D0003"]', { shiftKey: true });
    expect(ui.el.textContent).toContain('4 selected');
    ui.change('Set status', 'reviewed');
    const status = (id: string) => workspace.getState().issues.find((i) => i.id === id)?.status;
    expect(['i0', 'i1', 'i2', 'i3', 'i4'].map(status)).toEqual([
      'reviewed',
      'reviewed',
      'reviewed',
      'reviewed',
      'draft',
    ]);
    act(() => {
      issueEditor.undo();
    });
    expect(status('i2')).toBe('draft');
    ui.unmount();
  });

  it('selects every shown issue and merges duplicates', () => {
    workspace
      .getState()
      .openProject({ id: 'big', root: 'r', manifest }, [
        ...many(6),
        makeIssue({ id: 'dup', code: 'F99', title: 'Pothole twin' }),
      ]);
    const ui = mount();
    const search = ui.q('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('no search');
    act(() => {
      // React tracks input values: set it through the prototype so the input event counts.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the input as this
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(search, 'longitudinal');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ui.rows()).toBe(2);
    ui.click('input[aria-label="Select all shown"]');
    expect(ui.el.textContent).toContain('2 selected');
    ui.click('button[aria-label="Merge selected"]');
    expect(workspace.getState().issues).toHaveLength(6);
    ui.unmount();
  });

  it('shows a chip for a scope set from outside and clears it with the chip button', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(20));
    const ui = mount();
    expect(ui.q('[data-testid="issue-scope-chip"]')).toBeNull();
    act(() => {
      setIssueView({ scope: { label: 'Three findings', ids: ['i1', 'i2', 'i3'] } });
    });
    expect(ui.rows()).toBe(3);
    const chip = ui.q('[data-testid="issue-scope-chip"]');
    expect(chip?.textContent).toContain('Three findings');
    ui.click('button[aria-label="Clear the filter Three findings"]');
    expect(ui.q('[data-testid="issue-scope-chip"]')).toBeNull();
    expect(ui.rows()).toBeGreaterThan(5);
    ui.unmount();
  });

  it('opens every group when the grouping is changed from outside the register', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(50));
    const ui = mount();
    ui.change('Group', 'severity');
    const collapsedRows = () => ui.rows();
    const open = collapsedRows();
    ui.click('.ann-group');
    expect(collapsedRows()).toBeLessThan(open);
    act(() => {
      setIssueView({ groupBy: 'class' });
    });
    act(() => {
      setIssueView({ groupBy: 'severity' });
    });
    expect(collapsedRows()).toBe(open);
    ui.unmount();
  });

  it('keeps a filter when the register is left and opened again', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(20));
    const first = mount();
    first.change('Group', 'severity');
    first.unmount();
    expect(issueView.getState().groupBy).toBe('severity');
    const second = mount();
    const group = second.q('select[aria-label="Group"]');
    expect(group instanceof HTMLSelectElement && group.value).toBe('severity');
    second.unmount();
  });

  it('only browses in a read-only package: no checkboxes, bulk actions or undo', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(30));
    setAnnotateReadOnly(true);
    try {
      const ui = mount();
      expect(ui.rows()).toBeGreaterThan(5);
      expect(ui.q('input[type="checkbox"]')).toBeNull();
      expect(ui.q('.ann-bulk')).toBeNull();
      expect(ui.q('select[aria-label="Set status"]')).toBeNull();
      expect(ui.q('button[aria-label="Merge selected"]')).toBeNull();
      expect(ui.el.textContent).toContain('Read-only');
      expect(ui.el.textContent).not.toContain('Undo');
      ui.change('Group', 'status');
      expect(ui.q('.ann-group')).not.toBeNull();
      ui.click('.ann-row', { ctrlKey: true });
      expect(ui.el.textContent).not.toContain('selected');
      ui.unmount();
    } finally {
      setAnnotateReadOnly(false);
    }
  });
});

describe('IssueRegister right-click menu', () => {
  afterEach(() => {
    workspace.getState().closeProject();
  });

  const rightClick = (ui: ReturnType<typeof mount>, code: string) => {
    const row = [...ui.el.querySelectorAll('.ann-row')].find((r) => r.textContent.includes(code));
    if (!row) throw new Error(`no row ${code}`);
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });
    act(() => {
      row.dispatchEvent(ev);
    });
    return ev;
  };

  it('offers Place on model for the row, or for every checked row', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(5));
    const placeOnModel = vi.fn<(ids: readonly string[]) => void>();
    const off = setIssueListActions({ placeOnModel });
    const ui = mount();
    expect(rightClick(ui, 'D0001').defaultPrevented).toBe(true);
    const item = () => document.querySelector('[data-testid="issue-place-on-model"]');
    expect(item()?.textContent).toBe('Place on model...');
    act(() => {
      item()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(placeOnModel).toHaveBeenLastCalledWith(['i1']);
    expect(item()).toBeNull();
    ui.click('[data-tick="D0002"]');
    ui.click('[data-tick="D0003"]');
    rightClick(ui, 'D0003');
    expect(item()?.textContent).toBe('Place 2 on model...');
    act(() => {
      item()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect([...(placeOnModel.mock.lastCall?.[0] ?? [])].sort()).toEqual(['i2', 'i3']);
    // Esc closes it
    rightClick(ui, 'D0004');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(item()).toBeNull();
    off();
    ui.unmount();
  });

  it('leaves the browser menu alone without the action', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(2));
    const ui = mount();
    expect(rightClick(ui, 'D0001').defaultPrevented).toBe(false);
    expect(document.querySelector('[data-testid="issue-row-menu"]')).toBeNull();
    ui.unmount();
  });
});
