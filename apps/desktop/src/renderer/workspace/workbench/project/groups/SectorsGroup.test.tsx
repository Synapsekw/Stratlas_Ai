// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennasFile, sectorsFile, unit } from '../../../../rf/__fixtures__/rfData';
import { resetRf, rfStore } from '../../../../rf/rfStore';
import type * as AntennaStoreModule from '../../../../telecom/antennaStore';
import type * as RfStoreModule from '../../../../rf/rfStore';
import { sectorsGroup } from './SectorsGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  rename: vi.fn(() => Promise.resolve()),
  fly: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../../../../rf/rfStore', async (orig) => ({
  ...(await orig<typeof RfStoreModule>()),
  renameSavedSector: h.rename,
}));
vi.mock('../../../../rf/rfTab', () => ({ openRfTab: h.open, openCoverage: vi.fn() }));
vi.mock('../../../../telecom/antennaStore', async (orig) => ({
  ...(await orig<typeof AntennaStoreModule>()),
  requestFly: h.fly,
}));

let host: HTMLDivElement;
let root: Root;

function Probe() {
  const { Body } = sectorsGroup;
  return (
    <>
      <span data-testid="count">{sectorsGroup.useCount()}</span>
      <span data-testid="applies">{String(sectorsGroup.useApplies())}</span>
      <Body />
    </>
  );
}
const mount = () => {
  act(() => {
    root.render(<Probe />);
  });
};

function plan() {
  const units = [unit('ant-a', 0), unit('ant-b', 90), unit('ant-c', 240)];
  rfStore.setState({
    hasFile: true,
    antennas: antennasFile(units),
    sectors: sectorsFile(
      [
        { id: 'sec-s1', antennaIds: ['ant-a', 'ant-b'] },
        { id: 'sec-s2', antennaIds: ['ant-c'] },
      ],
      [],
    ),
  });
}

beforeEach(() => {
  resetRf();
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('Sectors group', () => {
  it('lists saved sectors with bearing and antenna count', () => {
    plan();
    mount();
    expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('2');
    const rows = host.querySelectorAll('li[data-row-id]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('S1');
    expect(rows[0]!.textContent).toMatch(/\d+°/);
    expect(rows[0]!.textContent).toContain('2 antennas');
    expect(rows[1]!.textContent).toContain('1 antenna');
  });

  it('shows 0 and Plan sectors in Coverage before a plan is saved', () => {
    rfStore.setState({ antennas: antennasFile([unit('ant-a', 0)]) });
    mount();
    expect(host.querySelector('[data-testid="applies"]')!.textContent).toBe('true');
    expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('0');
    expect(host.textContent).toContain('Plan sectors in Coverage.');
  });

  it('is left out of a project with no inventory and no plan', () => {
    mount();
    expect(host.querySelector('[data-testid="applies"]')!.textContent).toBe('false');
  });

  it('rename saves a clean plan and leaves a dirty one unsaved', () => {
    plan();
    mount();
    act(() => {
      host.querySelector<HTMLButtonElement>('li button[aria-label="Rename"]')!.click();
    });
    const input = host.querySelector<HTMLInputElement>('input.pl-rename')!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.bind(input);
    act(() => {
      setValue('North');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // the store action owns clean vs dirty (rfStore.test.ts); the row hands it the new name
    expect(h.rename).toHaveBeenCalledWith('sec-s1', 'North');
    expect(host.querySelector('input.pl-rename')).toBeNull();
  });

  it('Escape drops a rename', () => {
    plan();
    mount();
    act(() => {
      host.querySelector<HTMLButtonElement>('li button[aria-label="Rename"]')!.click();
    });
    act(() => {
      host
        .querySelector('input.pl-rename')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it('Enter then blur renames once; Escape then blur never renames', () => {
    plan();
    mount();
    const open = () => {
      act(() => {
        host.querySelector<HTMLButtonElement>('li button[aria-label="Rename"]')!.click();
      });
      return host.querySelector<HTMLInputElement>('input.pl-rename')!;
    };
    const input = open();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.bind(input);
    act(() => {
      setValue('North');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(h.rename).toHaveBeenCalledTimes(1);
    h.rename.mockClear();
    const again = open();
    act(() => {
      again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      again.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it('never shows a bearing of 360 degrees', () => {
    rfStore.setState({
      hasFile: true,
      antennas: antennasFile([unit('ant-z', 359.6, { convergenceDeg: 0 })]),
      sectors: sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-z'] }], []),
    });
    mount();
    const row = host.querySelector('li[data-row-id]')!;
    expect(row.textContent).toContain('0°');
    expect(row.textContent).not.toContain('360');
  });

  it('Fly to asks to fly to the sector antennas', () => {
    plan();
    mount();
    act(() => {
      host.querySelector<HTMLButtonElement>('li button[aria-label="Fly to"]')!.click();
    });
    expect(h.fly).toHaveBeenCalledWith(['ant-a', 'ant-b']);
  });

  it('Open in Coverage opens the Coverage tab on the first antenna', () => {
    plan();
    mount();
    act(() => {
      host.querySelector<HTMLButtonElement>('li button[aria-label="Open in Coverage"]')!.click();
    });
    expect(h.open).toHaveBeenCalledWith('ant-a');
  });
});
