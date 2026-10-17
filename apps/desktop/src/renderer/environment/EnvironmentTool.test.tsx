// @vitest-environment jsdom
import type { EngineStage } from '@aio/engine';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threeDates } from '../workspace/__fixtures__/threeDates';
import type * as StageToolsModule from '../workspace/StageTools';
import { workbench } from '../workspace/workbench/workbenchStore';
import { EnvironmentTab, EnvironmentTool } from './EnvironmentTool';

// the live 3D stage: here a stub that has the environment the panel reads
const stage = {
  environment: {
    mode: 'studio',
    location: null,
    timeMs: 0,
    sun: { azimuthDeg: 0, elevationDeg: 10 },
    water: false,
    waterLevel: null,
    dataWaterLevel: null,
  },
  onStateChange: () => () => undefined,
} as unknown as EngineStage;
let live: EngineStage | null = stage;
vi.mock('../workspace/StageTools', async (importOriginal) => ({
  ...(await importOriginal<typeof StageToolsModule>()),
  useEngineStage: () => live,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const render = (node: React.ReactNode) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(node);
  });
};

beforeEach(() => {
  live = stage;
  localStorage.clear();
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('Environment as a panel tab', () => {
  it('opens as an unpinned View panel tab in front, not as a popover', () => {
    render(<EnvironmentTool stage={stage} />);
    const open = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Environment and time of day"]',
    );
    expect(open?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      open?.click();
    });
    const s = workbench.getState();
    expect(s.front).toBe('environment');
    expect(s.tabs.find((t) => t.id === 'environment')).toMatchObject({
      fixed: false,
      pinned: false,
    });
    // nothing opens beside the button: the panel is the tab's
    expect(host.querySelector('[data-testid="env-panel"]')).toBeNull();
  });

  it('shows the panel with env-panel in its tab', () => {
    render(<EnvironmentTab />);
    const panel = host.querySelector('[data-testid="env-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Environment');
    expect(panel?.querySelector('[role="group"][aria-label="Backdrop"]')).not.toBeNull();
  });

  it('asks for the 3D view when the stage is not there', () => {
    live = null;
    render(<EnvironmentTab />);
    expect(host.querySelector('[data-testid="env-panel"]')).toBeNull();
    expect(host.textContent).toContain('Open the 3D view');
  });

  it('toggles: a click while its tab is in front closes the tab', () => {
    render(<EnvironmentTool stage={stage} />);
    const open = () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Environment and time of day"]');
    act(() => open()?.click());
    expect(workbench.getState().front).toBe('environment');
    act(() => open()?.click());
    expect(workbench.getState().tabs.some((t) => t.id === 'environment')).toBe(false);
  });

  it('says to open a project when there is none', () => {
    workspace.getState().closeProject();
    render(<EnvironmentTab />);
    expect(host.textContent).toContain('Open a project');
    expect(host.textContent).not.toContain('3D view');
  });
});
