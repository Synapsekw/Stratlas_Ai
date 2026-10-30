// @vitest-environment jsdom
import type { AioBridge, IpcChannel, IpcResponse, PackageInfo, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import type { Screen } from '../store';
import { AgentDock, useAgentDockOpen } from './AgentDock';
import { AgentToggle } from './AgentToggle';
import { appAgentSession } from './session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A main process whose agent is ready; the session of the app is made on it at first use. */
const aio: AioBridge = {
  invoke: <C extends IpcChannel>(channel: C) => {
    const route = { task: 'chat', provider: 'openai', model: 'gpt-5' };
    const answer: Partial<Record<IpcChannel, unknown>> = {
      'ai:status': { ready: true, route, cloud: true },
      'ai:project': { alwaysAllow: true, policy: 'allow', usage: [] },
      'ai:send': { ok: true },
      'ai:cancel': { ok: true },
      'ai:saveConversation': { ok: true },
    };
    return Promise.resolve(answer[channel] as IpcResponse<C>);
  },
  on: () => () => undefined,
};
beforeAll(() => {
  (globalThis as { aio?: AioBridge }).aio = aio;
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Tank farm',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const pkg = (aiPolicy: 'forbid' | 'allow'): PackageInfo => ({
  file: 'D:\\site.aio',
  encrypted: false,
  sizeBytes: 1000,
  header: {
    schema: 'aio.package/1',
    projectId: 'p1',
    createdAt: '2026-10-04T08:00:00Z',
    readOnly: true,
    aiPolicy,
    exports: [],
    excludedLayers: [],
  },
});

/** What the app frame does with the column: the button, the column and the mark on `.app`. */
function Frame() {
  const open = useAgentDockOpen();
  return (
    <div data-testid="frame" data-agent-dock={open ? 'open' : undefined}>
      <AgentToggle />
      <AgentDock />
    </div>
  );
}

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  shell.setState({ screen: 'projects', pkg: null });
  shell.getState().setAgentDock(true);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  appAgentSession().reset();
});

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

async function render() {
  root = createRoot(host);
  act(() => root?.render(<Frame />));
  await settle();
}

async function show(screen: Screen, open = true) {
  if (open) workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest });
  shell.setState({ screen });
  await render();
}

const dock = () => host.querySelector<HTMLElement>('#agent-dock');
const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="agent-toggle"]');
const mark = () => host.querySelector<HTMLElement>('[data-testid="frame"]')?.dataset.agentDock;

describe('AgentDock', () => {
  it('is not there without a project', async () => {
    await show('inspect', false);
    expect(dock()).toBeNull();
    expect(toggle()).toBeNull();
    expect(mark()).toBeUndefined();
  });

  it('is folded away until asked for, out of the tab order and unseen by a screen reader', async () => {
    await show('inspect');
    const el = dock();
    expect(el?.tagName).toBe('ASIDE');
    expect(el?.className).toBe('agent-dock');
    expect(el?.getAttribute('aria-label')).toBe('Ask AI');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.hasAttribute('inert')).toBe(true);
    expect(mark()).toBeUndefined();
  });

  it('shows the agent panel when unfolded, and folds again', async () => {
    await show('inspect');
    act(() => {
      shell.getState().setAgentDock(false);
    });
    const el = dock();
    expect(el?.getAttribute('aria-hidden')).toBe('false');
    expect(el?.hasAttribute('inert')).toBe(false);
    expect(el?.querySelector('.agent > section.aio-agent.agent-host')).not.toBeNull();
    expect(mark()).toBe('open');
    act(() => {
      shell.getState().toggleAgentDock();
    });
    expect(dock()?.getAttribute('aria-hidden')).toBe('true');
    expect(mark()).toBeUndefined();
  });

  it('has a handle on its inner edge while open, and none while folded', async () => {
    await show('inspect');
    const handle = () => dock()?.querySelector<HTMLElement>('[role="separator"]') ?? null;
    expect(handle()).toBeNull();
    act(() => {
      shell.getState().setAgentDock(false);
    });
    expect(handle()?.getAttribute('aria-label')).toBe('Resize the assistant');
    expect(handle()?.getAttribute('aria-controls')).toBe('agent-dock');
    // today's width: 360 px, or a third of a narrow window
    expect(handle()?.getAttribute('aria-valuenow')).toBe(
      String(Math.min(360, Math.round(window.innerWidth * 0.33))),
    );
    act(() => {
      shell.getState().toggleAgentDock();
    });
    expect(handle()).toBeNull();
  });

  it('is on Issues, Inspect and Reports only', async () => {
    shell.getState().setAgentDock(false);
    await show('issues');
    for (const screen of ['issues', 'inspect', 'reports'] as const) {
      act(() => {
        shell.setState({ screen });
      });
      expect(dock(), screen).not.toBeNull();
      expect(mark(), screen).toBe('open');
    }
    // the Scene has the agent in its own right panel; the others have none
    for (const screen of ['scene', 'settings', 'projects', 'welcome', 'globe'] as const) {
      act(() => {
        shell.setState({ screen });
      });
      expect(dock(), screen).toBeNull();
      expect(toggle(), screen).toBeNull();
      expect(mark(), screen).toBeUndefined();
    }
  });

  it('binds the agent to the window of the screen it is on', async () => {
    shell.getState().setAgentDock(false);
    await show('issues');
    const tag = () => dock()?.querySelector('.ag-in .ag-tag')?.textContent;
    const onIssues = tag();
    act(() => {
      shell.setState({ screen: 'reports' });
    });
    await settle();
    expect(tag()).not.toBe(onIssues);
    expect(dock()?.querySelector('section.aio-agent')).not.toBeNull();
  });

  it('keeps the conversation when the person leaves the screen and comes back', async () => {
    shell.getState().setAgentDock(false);
    await show('inspect');
    await act(() => appAgentSession().send('Show the worst finding'));
    expect(dock()?.querySelector('.ag-msg.user')?.textContent).toContain('Show the worst finding');
    act(() => {
      shell.setState({ screen: 'settings' });
    });
    expect(dock()).toBeNull();
    act(() => {
      shell.setState({ screen: 'issues' });
    });
    await settle();
    expect(dock()?.querySelector('.ag-msg.user')?.textContent).toContain('Show the worst finding');
    expect(appAgentSession().getState().turns).toHaveLength(2);
  });

  it('says why there is no agent in a package that does not allow cloud AI', async () => {
    shell.getState().setAgentDock(false);
    shell.setState({ pkg: pkg('forbid') });
    await show('inspect');
    const blocked = dock()?.querySelector('[data-testid="agent-blocked"]');
    expect(blocked?.textContent).toBe(
      'This package does not allow cloud AI. Nothing from it is sent to any provider.',
    );
    expect(dock()?.querySelector('.aio-agent')).toBeNull();
    act(() => {
      shell.setState({ pkg: pkg('allow') });
    });
    expect(dock()?.querySelector('[data-testid="agent-blocked"]')).toBeNull();
    expect(dock()?.querySelector('.aio-agent')).not.toBeNull();
  });
});

describe('AgentToggle', () => {
  it('is a header button that names the column and says whether it is open', async () => {
    await show('inspect');
    const button = toggle();
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.type).toBe('button');
    expect(button?.classList.contains('btn')).toBe(true);
    expect(button?.textContent).toBe('Ask AI');
    // its tip is the shared Tip (described by), not a native title
    expect(button?.title).toBe('');
    expect(button?.getAttribute('aria-keyshortcuts')).toBeTruthy();
    expect(button?.getAttribute('aria-controls')).toBe('agent-dock');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.querySelector('svg')).not.toBeNull();
  });

  it('unfolds and folds the column', async () => {
    await show('issues');
    act(() => {
      toggle()?.click();
    });
    expect(shell.getState().agentDockCollapsed).toBe(false);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(dock()?.getAttribute('aria-hidden')).toBe('false');
    act(() => {
      toggle()?.click();
    });
    expect(shell.getState().agentDockCollapsed).toBe(true);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });
});
