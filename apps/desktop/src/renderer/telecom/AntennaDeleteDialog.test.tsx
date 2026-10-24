// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntennaDeleteDialog } from './AntennaDeleteDialog';
import { antennaDeleteStore } from './antennaDelete';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('./antennaDelete', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  confirmDeleteAntennas: confirm,
}));

const ask = {
  ids: ['ant-b'],
  names: ['P2'],
  sectors: [{ unitId: 'ant-b', unitName: 'P2', sector: 'North' }],
  planUnsaved: false,
};

let root: Root;
let mount: HTMLElement;
beforeEach(() => {
  confirm.mockClear();
  antennaDeleteStore.setState({ ask, busy: false });
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

const show = () => {
  act(() => {
    root.render(<AntennaDeleteDialog />);
  });
};
// the dialog is portalled to the body
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = () => document.body.textContent;

describe('AntennaDeleteDialog', () => {
  it('names the unit, the sector and offers Delete', () => {
    show();
    expect(q('antenna-delete-confirm')?.querySelector('h2')?.textContent).toBe('Delete P2?');
    expect(text()).toContain('P2 is in sector North');
    expect(q('antenna-delete-confirm-yes')?.textContent).toContain('Delete');
    act(() => {
      q('antenna-delete-confirm-yes')?.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('counts many units and warns of an unsaved plan', () => {
    antennaDeleteStore.setState({
      ask: { ...ask, ids: ['a', 'b', 'c'], names: ['A', 'B', 'C'], planUnsaved: true },
    });
    show();
    expect(q('antenna-delete-confirm')?.querySelector('h2')?.textContent).toBe(
      'Delete 3 antennas?',
    );
    expect(q('antenna-delete-confirm-yes')?.textContent).toContain('Delete 3');
    expect(q('antenna-delete-plan-unsaved')).not.toBeNull();
  });

  it('Escape cancels', () => {
    show();
    act(() => {
      q('antenna-delete-confirm-cancel')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('disables the button while busy', () => {
    antennaDeleteStore.setState({ busy: true });
    show();
    const yes = q('antenna-delete-confirm-yes') as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
  });

  it('renders nothing without a question', () => {
    antennaDeleteStore.setState({ ask: null });
    show();
    expect(q('antenna-delete-confirm')).toBeNull();
  });
});
