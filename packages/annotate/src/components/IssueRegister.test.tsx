// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { issueEditor, setAnnotateReadOnly } from '../runtime';
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
