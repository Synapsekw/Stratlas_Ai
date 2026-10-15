// @vitest-environment jsdom
import { pointcloudCleanup, pointcloudSettings } from '@aio/pointcloud';
import { emptyCleanup } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '../pointcloud/cleanupStore';
import { StageClassLegend } from './StageLegends';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: { ok: true, trashed: [] } }) },
  useShell: () => null,
}));
vi.mock('@aio/pointcloud', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useClassificationLegend: () => ({ counts: { 2: 80, 7: 20 }, hidden: [] }),
}));

let host: HTMLDivElement;
let root: Root;
const commit = vi.fn();
const toggle = vi.fn();
const recipe = { ...emptyCleanup('a'), hiddenClasses: [18] };

const mount = () => {
  root = createRoot(host);
  act(() => {
    root.render(<StageClassLegend />);
  });
};
const press = (i: number) => {
  act(() => {
    host.querySelectorAll('button')[i]?.click();
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  commit.mockReset().mockResolvedValue(true);
  toggle.mockReset();
  pointcloudCleanup.getState().clear();
  pointcloudCleanup.getState().set('a', recipe);
  cleanup.store.setState({ active: 'a', panelOpen: false, readOnly: false });
  Object.assign(cleanup, { commit });
  pointcloudSettings.setState({ toggleClass: toggle });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.setState({ hidden: {} });
});

describe('StageClassLegend', () => {
  it('with the panel open edits the active cloud as one undo step, under its name', () => {
    cleanup.store.setState({ panelOpen: true });
    mount();
    expect(host.textContent).toContain('Classes: ');
    press(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('a', { ...recipe, hiddenClasses: [7, 18] });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('with the panel closed edits the global setting and notes that clouds keep their own', () => {
    mount();
    expect(host.textContent).toContain('Clouds with cleanup keep their own classes.');
    press(0);
    expect(toggle).toHaveBeenCalledWith(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows no note when no cloud has a recipe', () => {
    pointcloudCleanup.getState().clear();
    mount();
    expect(host.textContent).not.toContain('keep their own classes');
  });

  it('is disabled with a read-only tooltip while the panel is open in a read-only project', () => {
    cleanup.store.setState({ panelOpen: true, readOnly: true });
    mount();
    expect(host.querySelector('[inert]')).not.toBeNull();
    expect(host.querySelector('[title*="read-only"]')).not.toBeNull();
    press(0);
    expect(commit).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });
});
