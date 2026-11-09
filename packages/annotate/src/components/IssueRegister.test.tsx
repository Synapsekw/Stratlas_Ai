// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIssueView, issueView } from '../model/view';
import { issueEditor, setAnnotateReadOnly, setIssueListActions } from '../runtime';
import { catalogue, makeIssue, strictModel, tankModel } from '../testing';
import { hiddenFilterCount, IssueRegister } from './IssueRegister';

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

function mount(ui: ReactElement = <IssueRegister />) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(ui);
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

  it('select toggle works with Space', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(5));
    const ui = mount();
    const tick = ui.q('[data-tick="D0001"]');
    if (!(tick instanceof HTMLButtonElement)) throw new Error('the tick is not a button');
    // a real checkbox control in a grid row (a listbox option may hold no control)
    expect(tick.getAttribute('role')).toBe('checkbox');
    expect(tick.getAttribute('aria-label')).toBe('Select D0001');
    expect(tick.getAttribute('aria-checked')).toBe('false');
    expect(tick.closest('[role="gridcell"]')?.parentElement?.getAttribute('role')).toBe('row');
    expect(ui.q('[data-issue-list]')?.getAttribute('role')).toBe('grid');
    // select the row first: the list's own Space ticks the selected row, so a key that reached
    // the list as well would tick it twice (back off)
    const row = tick.closest('.ann-row');
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(row?.getAttribute('aria-selected')).toBe('true');
    expect(tick.tabIndex).toBe(0);
    const space = () => {
      const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      act(() => {
        tick.focus();
        tick.dispatchEvent(ev);
      });
      return ev;
    };
    const ev = space();
    expect(ev.defaultPrevented).toBe(true);
    expect(tick.getAttribute('aria-checked')).toBe('true');
    expect(ui.el.textContent).toContain('1 selected');
    space();
    expect(tick.getAttribute('aria-checked')).toBe('false');
    expect(ui.el.textContent).not.toContain('1 selected');
    ui.unmount();
  });

  it('an arrow pressed on a tick steps the list and takes focus back to it', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(5));
    const ui = mount();
    const list = ui.q('[data-issue-list]');
    if (!(list instanceof HTMLElement)) throw new Error('no list');
    const row = (code: string) => ui.q(`[data-tick="${code}"]`)?.closest('.ann-row');
    act(() => {
      row('D0001')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // the grid names its rows and the selected one
    expect(list.getAttribute('aria-rowcount')).toBe('5');
    expect(row('D0001')?.getAttribute('aria-rowindex')).toBe('2');
    expect(list.getAttribute('aria-activedescendant')).toBe(row('D0001')?.id);
    // Tab from the list lands on the selected row's tick: the one tick in the Tab order
    expect([...ui.el.querySelectorAll('.ann-tick[tabindex="0"]')]).toHaveLength(1);
    const tick = ui.q('[data-tick="D0001"]');
    if (!(tick instanceof HTMLButtonElement)) throw new Error('no tick');
    const press = (target: HTMLElement, key: string) => {
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    };
    act(() => {
      tick.focus();
    });
    press(tick, 'ArrowDown');
    expect(row('D0002')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(row('D0002')?.id);
    // Space now ticks the selected row, not the one the tick was on
    press(list, ' ');
    expect(ui.q('[data-tick="D0002"]')?.getAttribute('aria-checked')).toBe('true');
    expect(tick.getAttribute('aria-checked')).toBe('false');
    ui.unmount();
  });

  it('a press on a tick puts the focus on the list, so the arrows work after it', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(5));
    const ui = mount();
    const search = ui.q('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('no search');
    act(() => {
      search.focus();
    });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      ui.q('[data-tick="D0003"]')?.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ui.q('[data-issue-list]'));
    ui.unmount();
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
    // a row that is not among the checked ones acts alone
    rightClick(ui, 'D0004');
    expect(item()?.textContent).toBe('Place on model...');
    expect(document.activeElement).toBe(item());
    act(() => {
      item()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(placeOnModel).toHaveBeenLastCalledWith(['i4']);
    // Esc closes it
    rightClick(ui, 'D0004');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(item()).toBeNull();
    // so does a press elsewhere
    rightClick(ui, 'D0004');
    expect(item()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(item()).toBeNull();
    off();
    ui.unmount();
  });

  it('a right-click asks the issue menu hook when one is set', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(3));
    const issueMenu =
      vi.fn<(at: { x: number; y: number }, ids: readonly string[], clicked: string) => void>();
    const off = setIssueListActions({ issueMenu });
    const ui = mount();
    expect(rightClick(ui, 'D0002').defaultPrevented).toBe(true);
    expect(issueMenu).toHaveBeenLastCalledWith({ x: 30, y: 40 }, ['i2'], 'i2');
    ui.click('[data-tick="D0001"]');
    ui.click('[data-tick="D0002"]');
    rightClick(ui, 'D0002');
    const [, ids, clicked] = issueMenu.mock.lastCall ?? [];
    expect([...(ids ?? [])].sort()).toEqual(['i1', 'i2']);
    expect(clicked).toBe('i2');
    expect(document.querySelector('[data-testid="issue-place-on-model"]')).toBeNull();
    off();
    ui.unmount();
  });

  it('issueFilter leaves other issues out of the list', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(3));
    const ui = mount(<IssueRegister issueFilter={(i) => i.id !== 'i2'} />);
    const codes = [...ui.el.querySelectorAll('.ann-row')].map((r) => r.textContent);
    expect(codes.some((c) => c.includes('D0001'))).toBe(true);
    expect(codes.some((c) => c.includes('D0002'))).toBe(false);
    ui.unmount();
  });

  it('leaves the browser menu alone in a read-only package', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(2));
    const off = setIssueListActions({ placeOnModel: vi.fn() });
    setAnnotateReadOnly(true);
    const ui = mount();
    try {
      expect(rightClick(ui, 'D0001').defaultPrevented).toBe(false);
      expect(document.querySelector('[data-testid="issue-row-menu"]')).toBeNull();
    } finally {
      setAnnotateReadOnly(false);
      off();
      ui.unmount();
    }
  });

  it('leaves the browser menu alone without the action', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(2));
    const ui = mount();
    expect(rightClick(ui, 'D0001').defaultPrevented).toBe(false);
    expect(document.querySelector('[data-testid="issue-row-menu"]')).toBeNull();
    ui.unmount();
  });

  it('takes the screen title and actions into its own header row, so a screen has one heading', () => {
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(3));
    const ui = mount(
      <IssueRegister
        heading="Issue register"
        headingLevel={2}
        actions={
          <button type="button" data-testid="extra">
            Export
          </button>
        }
      />,
    );
    // under the screen's h1: an h2, so the heading levels go up by one
    const heads = [...ui.el.querySelectorAll('h1, h2, h3')].map(
      (h) => `${h.tagName} ${h.textContent}`,
    );
    expect(heads).toEqual(['H2 Issue register']);
    const row = ui.q('.ann-h');
    expect(row?.querySelector('[data-testid="extra"]')).not.toBeNull();
    expect(row?.textContent).toContain('Undo');
    ui.unmount();
  });
});

describe('Filters (n)', () => {
  afterEach(() => {
    setIssueView({ dataset: '' });
    workspace.getState().closeProject();
  });

  it('Filters (n) counts the active hidden filters', () => {
    expect(hiddenFilterCount({ dataset: '', mine: false })).toBe(0);
    expect(hiddenFilterCount({ dataset: 'video', mine: false })).toBe(1);
    expect(hiddenFilterCount({ dataset: 'mesh', mine: true })).toBe(2);
    workspace.getState().openProject({ id: 'big', root: 'r', manifest }, many(20));
    const ui = mount();
    const button = () => ui.q('[data-testid="issue-filters"]');
    // three filters show (severity, class, status); the dataset waits behind Filters
    expect(ui.q('select[aria-label="Class"]')).not.toBeNull();
    expect(ui.q('select[aria-label="Status"]')).not.toBeNull();
    expect(ui.q('select[aria-label="Dataset"]')).toBeNull();
    expect(button()?.textContent).toBe('Filters');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    ui.click('[data-testid="issue-filters"]');
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    ui.change('Dataset', 'video');
    expect(button()?.textContent).toBe('Filters (1)');
    // folded away again, the count still says a filter cuts the list
    ui.click('[data-testid="issue-filters"]');
    expect(ui.q('select[aria-label="Dataset"]')).toBeNull();
    expect(button()?.textContent).toBe('Filters (1)');
    act(() => {
      setIssueView({ dataset: '' });
    });
    expect(button()?.textContent).toBe('Filters');
    ui.unmount();
  });
});
