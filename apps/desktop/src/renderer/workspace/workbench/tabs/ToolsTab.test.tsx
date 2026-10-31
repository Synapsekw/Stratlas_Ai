// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StageToolsModule from '../../StageTools';
import { measureStore, startTool, stopTool } from '../../../survey/measureStore';
import { threeDates } from '../../__fixtures__/threeDates';
import { workbench } from '../workbenchStore';
import { ToolsTab } from './ToolsTab';

// the benches are their own tests' (benches/*.test.tsx): here only what the tab puts around them
vi.mock('../FrontBody', () => ({
  FrontBody: ({ front }: { front: string }) => <p data-testid={`body-${front}`}>{front}</p>,
}));
vi.mock('../../compare', () => ({
  useCaptureIndex: () => ({ captures: [], layers: {} }),
}));
vi.mock('../../../survey/TelecomTools', () => ({
  TelecomTools: () => null,
  useTelecomUnavailable: () => null,
  startTelecomTool: vi.fn(),
}));
vi.mock('../../StageTools', async (importOriginal) => ({
  ...(await importOriginal<typeof StageToolsModule>()),
  useEngineStage: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

const render = () => {
  root ??= createRoot(host);
  act(() => root?.render(<ToolsTab />));
};
const sections = () =>
  [...host.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  measureStore.setState({ readOnly: false });
});
afterEach(() => {
  act(() => {
    stopTool();
  });
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('the Tools tab (W8)', () => {
  it("lists the registry's groups in its order, View first", () => {
    render();
    const ids = sections();
    expect(ids.slice(0, 3)).toEqual(['tools.view', 'tools.measure', 'tools.annotate']);
    // the project has video: its group is there, after the measuring groups
    expect(ids.indexOf('tools.video')).toBeGreaterThan(ids.indexOf('tools.annotate'));
  });

  it('an open group lists its tools, those that cannot start with why', () => {
    render();
    act(() => {
      workbench.getState().toggleSection('tools.view');
    });
    const view = host.querySelector('[data-section="tools.view"]');
    expect(view?.querySelector('[data-testid="tool-view.wholeSite"]')).not.toBeNull();
    // no 3D view here: Sky and time says so under its name
    const sky = view?.querySelector<HTMLButtonElement>('[data-testid="tool-view.skyTime"]');
    // greyed but reachable by Tab, with its reason; a press does nothing
    expect(sky?.disabled).toBe(false);
    expect(sky?.getAttribute('aria-disabled')).toBe('true');
    act(() => sky?.click());
    expect(workbench.getState().front).not.toBe('environment');
    expect(sky?.textContent).toContain('Open the 3D view first');
  });

  it('an armed tool replaces the list with its card and Back to tools, which returns', () => {
    render();
    act(() => {
      startTool('area');
    });
    expect(q('tools-armed')).not.toBeNull();
    expect(sections()).toEqual(['tools.measure']);
    act(() => q('tools-back')?.click());
    expect(measureStore.getState().tool).toBeNull();
    expect(q('tools-armed')).toBeNull();
    expect(sections()).toContain('tools.view');
  });

  it('a tool armed with Measure folded (M on the stage, a tile on the island) shows its card', () => {
    render();
    act(() => {
      if (workbench.getState().sections['tools.measure'] === true)
        workbench.getState().toggleSection('tools.measure');
    });
    expect(workbench.getState().sections['tools.measure']).not.toBe(true);
    act(() => {
      startTool('distance');
    });
    expect(q('tools-armed')).not.toBeNull();
    expect(workbench.getState().sections['tools.measure']).toBe(true);
    const measure = host.querySelector('[data-section="tools.measure"]');
    expect(measure?.getAttribute('data-open')).toBe('true');
    expect(q('body-measure')).not.toBeNull();
  });
});
