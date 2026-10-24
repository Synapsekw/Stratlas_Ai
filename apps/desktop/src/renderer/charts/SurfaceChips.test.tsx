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

  it('earlier swatches shade by date among the chips switched on, as the lines do', () => {
    // keys sort the other way round from the dates, so a key ranking would invert the greys
    const newer: ChipOption = {
      key: 'a-new',
      label: '01 Sep',
      kind: 'earlier',
      group: 'survey',
      date: '2026-09-01',
    };
    const older: ChipOption = {
      key: 'z-old',
      label: '04 Aug',
      kind: 'earlier',
      group: 'survey',
      date: '2026-08-04',
    };
    const opacity = (h: HTMLElement, k: string) =>
      Number(h.querySelector(`[data-chip="${k}"] .pc-swatch line`)?.getAttribute('stroke-opacity'));
    const props = {
      shown: [CURRENT, newer, older],
      addable: [],
      onToggle: () => undefined,
      onAdd: () => undefined,
      onRemove: () => undefined,
    };
    let h = mount(<SurfaceChips {...props} off={new Set()} />);
    expect(opacity(h, 'a-new')).toBeCloseTo(0.9);
    expect(opacity(h, 'z-old')).toBeCloseTo(0.35);
    // with the newer one off, the older is the only earlier line drawn: the newest grey
    act(() => root?.render(<SurfaceChips {...props} off={new Set(['a-new'])} />));
    h = host;
    expect(opacity(h, 'z-old')).toBeCloseTo(0.9);
  });

  it('a same-date swatch is the current colour, finer and dashed, and can be removed', () => {
    const DTM: ChipOption = {
      key: 'cap-2-dtm',
      label: '05 Oct, DTM',
      kind: 'same-date',
      group: 'survey',
      date: '2026-10-05',
    };
    const el = mount(
      <SurfaceChips
        shown={[CURRENT, DTM]}
        off={new Set()}
        addable={[]}
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const line = el.querySelector('[data-chip="cap-2-dtm"] .pc-swatch line');
    expect(line?.getAttribute('stroke')).toBe('var(--chart-current)');
    expect(line?.getAttribute('stroke-dasharray')).toBe('3 2');
    expect(line?.getAttribute('stroke-width')).toBe('2');
    expect(el.querySelector('[data-chip="cap-2-dtm"] .pc-chip-x')).not.toBeNull();
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

  it('a survey chip carries its surface state: ready, preparing 62 % and Prepare', () => {
    const onToggle = vi.fn();
    const onPrepare = vi.fn();
    const h = mount(
      <SurfaceChips
        shown={[
          { ...CURRENT, state: { kind: 'ready' } },
          { ...EARLIER, state: { kind: 'preparing', pct: 62 } },
          { ...OLDER, state: { kind: 'missing' } },
        ]}
        off={new Set()}
        addable={[]}
        onToggle={onToggle}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onPrepare={onPrepare}
      />,
    );
    const at = (k: string) => h.querySelector<HTMLElement>(`[data-chip="${k}"]`);
    expect(at('cap-2')?.getAttribute('data-state')).toBe('ready');
    expect(at('cap-1')?.getAttribute('data-state')).toBe('preparing');
    expect(at('cap-1')?.textContent).toContain('preparing 62 %');
    // a preparing chip is not toggleable
    const main = at('cap-1')?.querySelector<HTMLButtonElement>('.pc-chip-main');
    expect(main?.getAttribute('aria-disabled')).toBe('true');
    click(main);
    expect(onToggle).not.toHaveBeenCalled();
    // a missing one offers Prepare
    expect(at('cap-0')?.getAttribute('data-state')).toBe('missing');
    const prepare = at('cap-0')?.querySelector<HTMLButtonElement>('[data-testid="chip-prepare"]');
    expect(prepare?.textContent).toBe('Prepare');
    click(prepare);
    expect(onPrepare).toHaveBeenCalledWith('cap-0');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('a date without elevation is a disabled chip with "No elevation for this date"', () => {
    const onToggle = vi.fn();
    const h = mount(
      <SurfaceChips
        shown={[{ ...EARLIER, state: { kind: 'none' } }]}
        off={new Set()}
        addable={[]}
        onToggle={onToggle}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const el = h.querySelector<HTMLElement>('[data-chip="cap-1"]');
    expect(el?.getAttribute('data-state')).toBe('none');
    const main = el?.querySelector<HTMLButtonElement>('.pc-chip-main');
    expect(main?.getAttribute('aria-disabled')).toBe('true');
    const described = (main?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain('No elevation for this date');
    click(main);
    expect(onToggle).not.toHaveBeenCalled();
    expect(el?.querySelector('[data-testid="chip-prepare"]')).toBeNull();
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
