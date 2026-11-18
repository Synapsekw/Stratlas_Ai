// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTHING_HELD, type Held } from '../../tools/toolSets';

const h = vi.hoisted(() => ({
  pkg: null as { id: string } | null,
  call: vi.fn(),
  held: null as Held | null,
}));

vi.mock('../../shell', () => ({
  bridge: { call: h.call },
  useShell: (select: (s: { pkg: unknown }) => unknown) => select({ pkg: h.pkg }),
}));
vi.mock('../../tools/useToolSets', () => ({ useHeld: () => h.held }));

import { ToolSets } from './ToolSets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  layers: [],
  classCatalogues: [],
  purpose: 'survey',
} as unknown as ProjectManifest;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const open = (manifest: ProjectManifest) => {
  workspace.setState({ project: { id: 'p1', root: '/p', manifest } });
};
function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ToolSets />);
  });
}
const sw = (set: string) =>
  host?.querySelector<HTMLButtonElement>(`[data-testid="tool-set-${set}"] button`) ?? null;
const on = (set: string) => sw(set)?.getAttribute('aria-checked') === 'true';
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.pkg = null;
  h.held = NOTHING_HELD;
  h.call.mockReset();
  open(base);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  workspace.setState({ project: null });
});

describe('Settings, This project, Tool sets', () => {
  it('renders nothing without a project', () => {
    workspace.setState({ project: null });
    mount();
    expect(host?.innerHTML).toBe('');
  });

  it('lists the sets, on as the project type gives them, without Road outside a road project', () => {
    mount();
    expect(host?.querySelectorAll('[data-testid^="tool-set-"]')).toHaveLength(3);
    expect(on('earthworks')).toBe(true);
    expect(sw('road')).toBeNull();
    expect(on('telecom')).toBe(false);
    expect(on('thermal')).toBe(false);
    expect(host?.textContent).toContain('Tool sets');
  });

  it('offers Road in a road project, where it can be turned off', () => {
    open({ ...base, purpose: 'road', type: 'road' });
    mount();
    expect(host?.querySelectorAll('[data-testid^="tool-set-"]')).toHaveLength(4);
    expect(on('road')).toBe(true);
    expect(sw('road')?.disabled).toBe(false);
  });

  it('offers Road, locked on, in a project that holds a road model', () => {
    h.held = { ...NOTHING_HELD, road: true };
    mount();
    expect(on('road')).toBe(true);
    expect(sw('road')?.disabled).toBe(true);
    expect(host?.textContent).toContain('On: this project holds a road.');
  });

  it('follows the list a person chose', () => {
    open({ ...base, toolSets: ['telecom'] });
    mount();
    expect(on('earthworks')).toBe(false);
    expect(on('telecom')).toBe(true);
  });

  it('a set whose records the project holds is on and locked, with the reason', () => {
    h.held = { ...NOTHING_HELD, telecom: true };
    mount();
    expect(on('telecom')).toBe(true);
    expect(sw('telecom')?.disabled).toBe(true);
    expect(sw('earthworks')?.disabled).toBe(false);
    expect(host?.textContent).toContain('On: this project holds antennas or telecom measurements.');
    expect(host?.textContent).not.toContain('this project holds piles');
  });

  it('turning a set on saves the whole list and reads the manifest again', async () => {
    h.call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'project:open'
          ? {
              ok: true,
              value: { ok: true, manifest: { ...base, toolSets: ['earthworks', 'telecom'] } },
            }
          : { ok: true, value: { ok: true } },
      ),
    );
    mount();
    act(() => sw('telecom')?.click());
    await flush();
    await flush();
    expect(h.call).toHaveBeenCalledWith('project:setToolSets', {
      projectId: 'p1',
      toolSets: ['earthworks', 'telecom'],
    });
    expect(workspace.getState().project?.manifest.toolSets).toEqual(['earthworks', 'telecom']);
    expect(on('telecom')).toBe(true);
  });

  it('a set of the project type can be turned off', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: true } });
    mount();
    act(() => sw('earthworks')?.click());
    await flush();
    expect(h.call).toHaveBeenCalledWith('project:setToolSets', { projectId: 'p1', toolSets: [] });
  });

  it('a package shows the switches but cannot change them', () => {
    h.pkg = { id: 'p1' };
    mount();
    for (const set of ['earthworks', 'telecom', 'thermal']) expect(sw(set)?.disabled).toBe(true);
    expect(host?.textContent).toContain('read only');
  });

  it('shows why a save failed and leaves the switch as it was', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: false, error: 'The disk is full.' } });
    mount();
    act(() => sw('thermal')?.click());
    await flush();
    expect(host?.querySelector('[role="alert"]')?.textContent).toBe('The disk is full.');
    expect(on('thermal')).toBe(false);
  });
});
