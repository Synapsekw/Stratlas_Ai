// @vitest-environment jsdom
import type { Conflict, QuarantineEntry } from '@aio/schema';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictsPanel, type ConflictsPanelProps } from './Conflicts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RANA = `a_${'r'.repeat(26)}`;
const OMAR = `a_${'o'.repeat(26)}`;
const DEV = `d_${'a'.repeat(52)}`;
const hlc = (min: number) => `${String(1_790_000_000_000 + min * 60_000)}.0000.${DEV}`;
const op = (c: string) => c.repeat(64);
const names: Record<string, string> = { [RANA]: 'Rana Example', [OMAR]: 'Omar Sample' };

const severity: Conflict = {
  id: 'cf_1',
  target: { rec: 'issue', id: 'i_f02' },
  field: 'severity',
  ours: { value: 3, by: RANA, hlc: hlc(1), op: op('a') },
  theirs: { value: 4, by: OMAR, hlc: hlc(2), op: op('b') },
  kind: 'value',
  current: 'theirs',
};
const deleted: Conflict = {
  id: 'cf_2',
  target: { rec: 'issue', id: 'i_f04' },
  field: 'deleted',
  ours: { value: true, by: RANA, hlc: hlc(3), op: op('c') },
  theirs: { value: false, by: OMAR, hlc: hlc(4), op: op('d') },
  kind: 'delete-edit',
  current: 'theirs',
};
const recoded: Conflict = {
  id: 'cf_3',
  target: { rec: 'issue', id: 'i_b' },
  field: 'code',
  ours: { value: 'F09', by: OMAR, hlc: hlc(5), op: op('e') },
  theirs: { value: 'F10', by: RANA, hlc: hlc(6), op: op('f') },
  kind: 'code',
  current: 'theirs',
};
const quarantined: QuarantineEntry = {
  op: op('9'),
  chain: `${DEV}.r_${'a'.repeat(16)}`,
  seq: 4,
  by: OMAR,
  device: DEV,
  hlc: hlc(7),
  kind: 'manifest.entry',
  target: { rec: 'manifest', id: 'project' },
  reason: 'role',
  message: 'A reviewer may not make this change.',
};

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function mount(over: Partial<ConflictsPanelProps> = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const onResolve = vi.fn<ConflictsPanelProps['onResolve']>();
  const onRelease = vi.fn<NonNullable<ConflictsPanelProps['onRelease']>>();
  const props: ConflictsPanelProps = {
    conflicts: [severity],
    viewer: RANA,
    nameOf: (a) => names[a] ?? a,
    labelOf: (t) =>
      t.id === 'i_f02' ? 'F02' : t.id === 'i_f04' ? 'F04' : t.id === 'i_b' ? 'F10' : t.id,
    onResolve,
    onRelease,
    ...over,
  };
  act(() => {
    root.render(<ConflictsPanel {...props} />);
  });
  cleanup = () => {
    act(() => {
      root.unmount();
    });
    el.remove();
  };
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === name) ??
    expect.fail(`no button ${name}`);
  const click = async (name: string) => {
    await act(async () => {
      button(name).click();
      await Promise.resolve();
    });
  };
  return { el, onResolve, onRelease, button, click };
}

describe('ConflictsPanel', () => {
  it('shows both values, both people and both times, and keeps mine', async () => {
    const ui = mount();
    const text = ui.el.textContent;
    expect(text).toContain('F02 severity');
    expect(text).toContain('You, ');
    expect(text).toContain('Omar Sample, ');
    expect(text).toContain('In the project now');
    expect(ui.el.querySelector('[data-side="theirs"]')?.hasAttribute('data-current')).toBe(true);
    await ui.click('Keep mine');
    expect(ui.onResolve).toHaveBeenCalledWith(severity, 'ours', undefined);
    await ui.click('Keep theirs');
    expect(ui.onResolve).toHaveBeenLastCalledWith(severity, 'theirs', undefined);
  });

  it('edits a value: numbers stay numbers', async () => {
    const ui = mount();
    await ui.click('Edit');
    const input = ui.el.querySelector('input') ?? expect.fail('no input');
    expect(input.value).toBe('4');
    act(() => {
      // React tracks the value property: set it the way a person typing does
      Reflect.set(HTMLInputElement.prototype, 'value', '5', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ui.click('Save');
    expect(ui.onResolve).toHaveBeenCalledWith(severity, 'restore', 5);
  });

  it('restores an earlier value from history', async () => {
    const ui = mount({
      historyOf: () => [
        { field: 'severity', value: 2, absent: false, op: op('0'), hlc: hlc(0), by: RANA },
        { field: 'severity', value: 3, absent: false, op: op('a'), hlc: hlc(1), by: RANA },
      ],
    });
    expect(ui.el.textContent).toContain('Earlier values');
    await ui.click('Restore');
    expect(ui.onResolve).toHaveBeenCalledWith(severity, 'restore', 2);
  });

  it('offers Delete again or Keep it when a delete lost to an edit', async () => {
    const ui = mount({ conflicts: [deleted] });
    expect(ui.el.textContent).toContain(
      'You deleted F04 while Omar Sample changed it. It was kept.',
    );
    await ui.click('Delete again');
    expect(ui.onResolve).toHaveBeenCalledWith(deleted, 'ours', undefined);
    await ui.click('Keep it');
    expect(ui.onResolve).toHaveBeenLastCalledWith(deleted, 'theirs', undefined);
  });

  it('tells about a renumbered code until dismissed', async () => {
    const ui = mount({ conflicts: [recoded] });
    expect(ui.el.textContent).toContain(
      'F10 was F09. Another issue made apart has that code, so it is now F10.',
    );
    await ui.click('OK');
    expect(ui.onResolve).toHaveBeenCalledWith(recoded, 'theirs', undefined);
  });

  it('shows an error when the choice was not saved', async () => {
    const ui = mount();
    ui.onResolve.mockRejectedValueOnce(new Error('The project is read only.'));
    await ui.click('Keep mine');
    expect(ui.el.querySelector('[role="alert"]')?.textContent).toBe(
      'This was not saved: The project is read only.',
    );
  });

  it('lists quarantined changes; only an owner may apply one', async () => {
    const viewer = mount({ conflicts: [], quarantined: [quarantined] });
    expect(viewer.el.textContent).toContain('No conflicts.');
    expect(viewer.el.textContent).toContain('manifest.entry on project by Omar Sample');
    expect(viewer.el.textContent).toContain('Only an owner can apply these.');
    expect([...viewer.el.querySelectorAll('button')].map((b) => b.textContent)).toEqual([]);
    cleanup?.();
    const owner = mount({ conflicts: [], quarantined: [quarantined], canRelease: true });
    await owner.click('Apply anyway');
    expect(owner.onRelease).toHaveBeenCalledWith(quarantined);
  });
});
