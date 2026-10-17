// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import type { MenuProps } from './Menu';
import { Tabs, type TabItem } from './Tabs';

const menuCalls: MenuProps[] = [];
vi.mock('./Menu', () => ({
  Menu: (props: MenuProps) => {
    menuCalls.push(props);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  menuCalls.length = 0;
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

type K = 'a' | 'b' | 'c' | 'd';
const base: TabItem<K>[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
  { id: 'd', label: 'Delta' },
];

const render = (ui: ReactElement) => {
  act(() => {
    root.render(ui);
  });
};
function q(selector: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}
function tab(i: number): HTMLElement {
  const el = host.querySelectorAll<HTMLElement>('[role="tab"]')[i];
  if (!el) throw new Error(`no tab ${i}`);
  return el;
}
const tabIds = () => [...host.querySelectorAll('[role="tab"]')].map((e) => e.id);
const key = (el: Element, k: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

function Harness(p: { items?: TabItem<K>[]; start?: K; onChange?: (id: K) => void }) {
  const [v, setV] = useState<K>(p.start ?? 'a');
  return (
    <Tabs
      items={p.items ?? base}
      value={v}
      onChange={(id) => {
        p.onChange?.(id);
        setV(id);
      }}
      label="Sections"
      idPrefix="x"
    />
  );
}

describe('Tabs', () => {
  it('names the tablist and wires selection, ids and roving tabindex', () => {
    render(<Harness start="b" />);
    expect(q('[role="tablist"]').getAttribute('aria-label')).toBe('Sections');
    expect(tab(1).getAttribute('aria-selected')).toBe('true');
    expect(tab(1).tabIndex).toBe(0);
    expect(tab(0).getAttribute('aria-selected')).toBe('false');
    expect(tab(0).tabIndex).toBe(-1);
    expect(tab(0).id).toBe('x-tab-a');
    expect(tab(0).getAttribute('aria-controls')).toBe('x-panel-a');
  });

  it('moves with ArrowRight and ArrowLeft and calls onChange', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key(tab(0), 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(tab(1));
    key(tab(1), 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('reverses the arrows under dir=rtl', () => {
    const onChange = vi.fn();
    render(
      <div dir="rtl">
        <Harness start="b" onChange={onChange} />
      </div>,
    );
    key(tab(1), 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('a');
    key(tab(0), 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('puts a test id on the tab that asks for one', () => {
    render(
      <Harness items={[{ id: 'a', label: 'Alpha', testId: 'tab-alpha' }, ...base.slice(1)]} />,
    );
    expect(tab(0).dataset.testid).toBe('tab-alpha');
    expect(tab(1).hasAttribute('data-testid')).toBe(false);
  });

  it('shows a count in a mono span', () => {
    render(<Harness items={[{ id: 'a', label: 'Alpha', count: 7 }, ...base.slice(1)]} />);
    expect(tab(0).querySelector('span.mono')?.textContent).toBe('7');
  });

  it('shows a live dot with a text label', () => {
    render(<Harness items={[{ id: 'a', label: 'Alpha', live: true }, ...base.slice(1)]} />);
    const label = t('tabs.live');
    expect(tab(0).querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });

  it('close button calls onClose without selecting; middle-click too', () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <Harness
        onChange={onChange}
        items={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', onClose }, ...base.slice(2)]}
      />,
    );
    act(() => {
      q('.tab-x').click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      tab(1).dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pin and close are reachable by keyboard and leave the selection alone', () => {
    const onPinChange = vi.fn();
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <Harness
        onChange={onChange}
        items={[{ id: 'a', label: 'Alpha', onPinChange, onClose }, ...base.slice(1)]}
      />,
    );
    expect(q('.tab-pin').tabIndex).toBe(0);
    expect(q('.tab-x').tabIndex).toBe(0);
    expect(q('.tab-pin').getAttribute('aria-label')).toBeTruthy();
    expect(q('.tab-x').getAttribute('aria-label')).toBeTruthy();
    const order = [...host.querySelectorAll<HTMLElement>('button')].filter((b) => b.tabIndex >= 0);
    expect(order.slice(0, 3).map((b) => b.className)).toEqual(['tab', 'tab-pin', 'tab-x']);
    // Native buttons turn Enter and Space into a click; the click must not select the tab.
    act(() => {
      q('.tab-pin').click();
      q('.tab-x').click();
    });
    expect(onPinChange).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps pin and close out of the tablist, which owns only the tabs (axe aria-required-children)', () => {
    render(
      <Harness
        items={[
          { id: 'a', label: 'Alpha', onPinChange: vi.fn(), onClose: vi.fn() },
          { id: 'b', label: 'Beta', onClose: vi.fn() },
          ...base.slice(2),
        ]}
      />,
    );
    const list = q('[role="tablist"]');
    // nothing in the tablist's subtree but tabs and plain containers
    const inside = [...list.querySelectorAll('*')].filter(
      (el) => el.getAttribute('role') !== 'tab' && !el.closest('[role="tab"]'),
    );
    expect(inside.filter((el) => el.matches('button, [tabindex], [role]'))).toEqual([]);
    expect(list.contains(q('.tab-pin'))).toBe(false);
    expect(list.contains(q('.tab-x'))).toBe(false);
    // every tab belongs to it, by descent or by aria-owns, and it owns nothing else
    const owned = (list.getAttribute('aria-owns') ?? '').split(/\s+/).filter(Boolean);
    const ownedEls = owned.map((id) => document.getElementById(id));
    expect(ownedEls.every((el) => el?.getAttribute('role') === 'tab')).toBe(true);
    for (const t of host.querySelectorAll('[role="tab"]')) {
      expect(list.contains(t) || owned.includes(t.id), t.id).toBe(true);
    }
  });

  it('pin toggles with aria-pressed', () => {
    const onPinChange = vi.fn();
    render(
      <Harness
        items={[{ id: 'a', label: 'Alpha', pinned: true, onPinChange }, ...base.slice(1)]}
      />,
    );
    expect(q('.tab-pin').getAttribute('aria-pressed')).toBe('true');
    act(() => {
      q('.tab-pin').click();
    });
    expect(onPinChange).toHaveBeenCalledWith(false);
  });

  describe('overflow menu', () => {
    // Every tab is 100 wide; at 270 two fit beside the more button.
    function size(container: number) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains('tabs') ? container : 0;
      });
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains('tab-wrap') ? 100 : 0;
      });
    }
    function Over(p: {
      value?: K;
      order?: (id: K) => number;
      items?: TabItem<K>[];
      onChange?: (id: K) => void;
    }) {
      return (
        <Tabs
          items={p.items ?? base}
          value={p.value ?? 'a'}
          onChange={
            p.onChange ??
            (() => {
              /* unused */
            })
          }
          label="Sections"
          idPrefix="x"
          overflow="menu"
          {...(p.order ? { overflowOrder: p.order } : {})}
        />
      );
    }
    const lastItems = () => menuCalls[menuCalls.length - 1]?.items ?? [];

    it('moves the highest-order tabs into the more menu', () => {
      size(270);
      render(<Over />);
      expect(tabIds()).toEqual(['x-tab-a', 'x-tab-b']);
      expect(q('.tabs-more').textContent).toContain('2');
      expect(lastItems().map((i) => (i === 'separator' ? i : i.id))).toEqual(['c', 'd']);
    });

    it('honours overflowOrder and never overflows the selected tab', () => {
      size(270);
      render(<Over value="a" order={(id) => (id === 'a' ? 9 : id === 'b' ? 8 : 0)} />);
      expect(tabIds()).toContain('x-tab-a');
      expect(tabIds()).not.toContain('x-tab-b');
    });

    it('selecting an overflowed tab calls onChange', () => {
      size(270);
      const onChange = vi.fn();
      render(<Over onChange={onChange} />);
      const c = lastItems()[0];
      if (c === 'separator' || !c) throw new Error('no item');
      c.onSelect();
      expect(onChange).toHaveBeenCalledWith('c');
    });

    it('accents the more button when a live tab is inside', () => {
      size(270);
      render(<Over items={[...base.slice(0, 3), { id: 'd', label: 'Delta', live: true }]} />);
      expect(q('.tabs-more').classList.contains('acc')).toBe(true);
    });

    it('keeps the count, live and pinned marks on overflowed menu entries', () => {
      size(270);
      render(
        <Over
          items={[
            ...base.slice(0, 2),
            { id: 'c', label: 'Gamma', count: 3, pinned: true },
            { id: 'd', label: 'Delta', live: true },
          ]}
        />,
      );
      const [c, d] = lastItems();
      if (!c || !d || c === 'separator' || d === 'separator') throw new Error('no items');
      expect(c.label).toContain('3');
      expect(c.checked).toBe(true);
      expect(d.label).toContain(t('tabs.live'));
    });

    it('shows no more button when everything fits', () => {
      size(1000);
      render(<Over />);
      expect(host.querySelector('.tabs-more')).toBeNull();
      expect(tabIds()).toHaveLength(4);
    });
  });
});
