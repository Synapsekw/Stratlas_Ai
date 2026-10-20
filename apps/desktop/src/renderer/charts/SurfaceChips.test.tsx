// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShadeVs } from './ShadeVs';
import { SurfaceChips, type ChipOption } from './SurfaceChips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT: ChipOption = { key: 'cap-2', label: '05 Oct', kind: 'current', group: 'survey' };
const EARLIER: ChipOption = { key: 'cap-1', label: '01 Sep', kind: 'earlier', group: 'survey' };
const DESIGN: ChipOption = { key: 'd-1', label: 'Pad design', kind: 'design', group: 'design' };
const BASE: ChipOption = { key: 'base', label: 'Pile base', kind: 'base', group: 'base' };
const OLDER: ChipOption = { key: 'cap-0', label: '04 Aug', kind: 'earlier', group: 'survey' };

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('no element');
  act(() => {
    (el as HTMLElement).click();
  });
};

/** A stateful host, the way a consumer keeps the shown and off sets. */
function Harness(p: { onAdd?: (k: string) => void }) {
  const [shown, setShown] = useState<ChipOption[]>([CURRENT, EARLIER, DESIGN]);
  const [off, setOff] = useState<Set<string>>(new Set());
  return (
    <SurfaceChips
      shown={shown}
      off={off}
      addable={[OLDER, BASE, { ...DESIGN, key: 'd-2', label: 'Road design' }]}
      onToggle={(k) => {
        setOff((s) => {
          const n = new Set(s);
          if (n.has(k)) n.delete(k);
          else n.add(k);
          return n;
        });
      }}
      onAdd={(k) => p.onAdd?.(k)}
      onRemove={(k) => {
        setShown((s) => s.filter((o) => o.key !== k));
      }}
      testId="chips"
    />
  );
}

const chip = (h: HTMLElement, key: string) =>
  h.querySelector<HTMLButtonElement>(`[data-chip="${key}"] button[aria-pressed]`);

describe('SurfaceChips', () => {
  it('clicking a chip turns it off and on', () => {
    const h = mount(<Harness />);
    expect(chip(h, 'cap-2')?.getAttribute('aria-pressed')).toBe('true');
    expect(chip(h, 'd-1')?.getAttribute('aria-pressed')).toBe('true');
    click(chip(h, 'd-1'));
    expect(chip(h, 'd-1')?.getAttribute('aria-pressed')).toBe('false');
    click(chip(h, 'd-1'));
    expect(chip(h, 'd-1')?.getAttribute('aria-pressed')).toBe('true');
    // each chip has a swatch in its series style: the design dashed, the current solid
    const dash = (k: string) =>
      h.querySelector(`[data-chip="${k}"] .pc-swatch line`)?.getAttribute('stroke-dasharray');
    expect(dash('d-1')).toBe('6 4');
    expect(dash('cap-2') ?? '').toBe('');
  });

  it('remove takes it off', () => {
    const h = mount(<Harness />);
    const x = h.querySelector('[data-chip="cap-1"] button[aria-label="Remove 01 Sep"]');
    click(x);
    expect(h.querySelector('[data-chip="cap-1"]')).toBeNull();
    expect(h.querySelector('[data-chip="cap-2"]')).not.toBeNull();
    // the current survey cannot be removed, only turned off
    expect(h.querySelector('[data-chip="cap-2"] button[aria-label^="Remove"]')).toBeNull();
  });

  it('add menu groups surveys, designs, base', () => {
    const onAdd = vi.fn();
    const h = mount(<Harness onAdd={onAdd} />);
    const add = h.querySelector<HTMLButtonElement>('[data-testid="chips-add"]');
    expect(add?.textContent).toBe('+ Add survey or design');
    expect(add?.getAttribute('aria-expanded')).toBe('false');
    click(add);
    expect(add?.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const groups = [...(menu?.querySelectorAll('[role="group"]') ?? [])];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Surveys', 'Designs', 'Base']);
    expect(
      [...(groups[0]?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => b.textContent),
    ).toEqual(['04 Aug']);
    expect(groups[1]?.textContent).toContain('Road design');
    expect(groups[2]?.textContent).toContain('Pile base');
    click(groups[1]?.querySelector('[role="menuitem"]'));
    expect(onAdd).toHaveBeenCalledWith('d-2');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('one surface: no Shade vs control', () => {
    let h = mount(<ShadeVs targets={[]} value={null} onChange={() => undefined} />);
    expect(h.innerHTML).toBe('');
    act(() => root?.unmount());
    root = undefined;
    host.remove();

    const onChange = vi.fn();
    h = mount(
      <ShadeVs
        targets={[
          { key: 'cap-1', label: '01 Sep' },
          { key: 'd-1', label: 'Design' },
        ]}
        value="d-1"
        onChange={onChange}
      />,
    );
    const group = h.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Shade vs');
    const buttons = [...h.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(buttons.map((b) => b.textContent)).toEqual(['01 Sep', 'Design', 'None']);
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    click(buttons[0]);
    expect(onChange).toHaveBeenLastCalledWith('cap-1');
    click(buttons[2]);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
