// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pkg: null as { id: string } | null,
  call: vi.fn(),
}));

vi.mock('../../shell', () => ({
  bridge: { call: h.call },
  useShell: (select: (s: { pkg: unknown }) => unknown) => select({ pkg: h.pkg }),
}));

import { ProjectPrivacy } from './ProjectPrivacy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  layers: [],
} as unknown as ProjectManifest;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ProjectPrivacy />);
  });
}
const sw = () =>
  host?.querySelector<HTMLButtonElement>('[data-testid="keep-local"] button') ?? null;
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.pkg = null;
  h.call.mockReset();
  workspace.setState({ project: { id: 'p1', root: '/p', manifest: base } });
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

describe('ProjectPrivacy', () => {
  it('renders nothing without a project', () => {
    workspace.setState({ project: null });
    mount();
    expect(host?.innerHTML).toBe('');
  });

  it('reflects aiPolicy forbid', () => {
    workspace.setState({
      project: { id: 'p1', root: '/p', manifest: { ...base, aiPolicy: 'forbid' } },
    });
    mount();
    expect(sw()?.getAttribute('aria-checked')).toBe('true');
    expect(host?.textContent).toContain('Nothing from this project is sent');
  });

  it('is off by default and says cloud runs still ask', () => {
    mount();
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
    expect(host?.textContent).toContain('Cloud runs still ask before anything is sent.');
  });

  it('toggling calls the bridge and reads the manifest again', async () => {
    h.call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'project:open'
          ? { ok: true, value: { ok: true, manifest: { ...base, aiPolicy: 'forbid' } } }
          : { ok: true, value: { ok: true } },
      ),
    );
    mount();
    act(() => sw()?.click());
    await flush();
    await flush();
    expect(h.call).toHaveBeenCalledWith('ai:setProjectPolicy', {
      projectId: 'p1',
      keepLocal: true,
    });
    expect(workspace.getState().project?.manifest.aiPolicy).toBe('forbid');
  });

  it('shows a package disabled', () => {
    h.pkg = { id: 'pkg' };
    mount();
    expect(sw()?.disabled).toBe(true);
    expect(host?.textContent).toContain("A package's AI sharing is set by whoever made it.");
  });

  it('shows a failure in an alert', async () => {
    h.call.mockResolvedValue({ ok: true, value: { ok: false, error: 'Disk is full.' } });
    mount();
    act(() => sw()?.click());
    await flush();
    expect(host?.querySelector('[role="alert"]')?.textContent).toBe('Disk is full.');
  });
});
