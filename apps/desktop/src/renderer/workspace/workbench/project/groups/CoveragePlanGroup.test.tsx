// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM lookups that fail the test when missing */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennasFile, unit } from '../../../../rf/__fixtures__/rfData';
import { resetRf, rfStore } from '../../../../rf/rfStore';
import { coveragePlanGroup } from './CoveragePlanGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../../rf/rfTab', () => ({ openRfTab: vi.fn(), openCoverage: h.open }));

let host: HTMLDivElement;
let root: Root;

function Probe() {
  const { Body } = coveragePlanGroup;
  return (
    <>
      <span data-testid="count">{coveragePlanGroup.useCount()}</span>
      <Body />
    </>
  );
}
const mount = () => {
  act(() => {
    root.render(<Probe />);
  });
};
const run = (runId: string, createdAt: string, status: 'done' | 'failed') =>
  ({ runId, createdAt, status }) as never;

beforeEach(() => {
  resetRf();
  vi.clearAllMocks();
  rfStore.setState({ antennas: antennasFile([unit('ant-a', 0)]) });
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

describe('Coverage plan group', () => {
  it('says not planned, then the last run date', () => {
    mount();
    expect(host.textContent).toContain('not planned');
    rfStore.setState({
      runs: [
        run('r3', '2026-10-20T10:00:00Z', 'failed'),
        run('r2', '2026-10-18T10:00:00Z', 'done'),
        run('r1', '2026-10-10T10:00:00Z', 'done'),
      ],
    });
    mount();
    expect(host.textContent).toContain(
      `last run ${new Date('2026-10-18T10:00:00Z').toLocaleDateString()}`,
    );
  });

  it('opens Coverage', () => {
    mount();
    act(() => {
      host.querySelector<HTMLButtonElement>('button')!.click();
    });
    expect(h.open).toHaveBeenCalled();
  });
});
