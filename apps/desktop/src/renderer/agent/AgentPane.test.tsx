// @vitest-environment jsdom
import type { AioBridge, IpcChannel, IpcResponse } from '@aio/schema';
import { createSplitPrefs, matchShortcut, splitPrefs } from '@aio/ui';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { PANEL_ID } from '../shell/PanelHandle';
import { openAgent } from '../shell/RightHeader';
import { createWorkbenchStore } from '../workspace/workbench/workbenchStore';
import { AgentPane } from './AgentPane';
import {
  AGENT_SPLIT_DEFAULT,
  agentPane,
  createAgentPaneStore,
  CTX_AGENT,
  startAgentPaneFollow,
} from './agentPaneStore';
import { appAgentSession } from './session';

// the agent itself is the package's panel: here a box and the header buttons the pane gives it
vi.mock('./AgentHost', () => ({
  AgentHost: ({ actions }: { actions?: ReactNode }) => (
    <section aria-label="Agent">
      <textarea aria-label="Message the agent" />
      {actions}
    </section>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A main process whose agent is ready, or off, as each test says. */
let ready = true;
const aio: AioBridge = {
  invoke: <C extends IpcChannel>(channel: C) => {
    const route = { task: 'chat', provider: 'openai', model: 'gpt-5' };
    const answer: Partial<Record<IpcChannel, unknown>> = {
      'ai:status': ready
        ? { ready: true, route, cloud: true }
        : { ready: false, reason: 'cloud-off', message: 'Cloud AI is off.' },
    };
    return Promise.resolve(answer[channel] as IpcResponse<C>);
  },
  on: () => () => undefined,
};
beforeAll(() => {
  (globalThis as { aio?: AioBridge }).aio = aio;
});

let host: HTMLDivElement;
let root: Root | undefined;

/** The right sidebar as the Scene has it: the tab bar, then the bench and agent split. */
function render() {
  root ??= createRoot(host);
  act(() => {
    root?.render(
      <aside className="right" id={PANEL_ID.right}>
        <div role="tablist" aria-label="Workbench">
          <button type="button" role="tab">
            Selection
          </button>
        </div>
        <AgentPane bench={<p data-testid="bench">bench</p>} window="scene3d" />
      </aside>,
    );
  });
}

async function setReady(on: boolean) {
  ready = on;
  await act(() => appAgentSession().refresh());
}

const byName = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('button, [role="separator"]')].find((b) =>
    (b.getAttribute('aria-label') ?? b.textContent).includes(name),
  );
const click = (el: HTMLElement | undefined) => {
  act(() => {
    el?.click();
  });
};
const shown = (el: Element | null | undefined) => !!el && !el.closest('[hidden]');
const bench = () => host.querySelector('[data-testid="bench"]');
const input = () => host.querySelector('textarea');

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  agentPane.setState({ mode: 'normal', folded: null, userSized: false });
  splitPrefs.setState({ byId: {} });
  shell.setState({ screen: 'scene', rightCollapsed: false });
  await setReady(true);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

describe('AgentPane', () => {
  it('maximise hides the bench body but keeps the tab bar, and Restore brings it back', () => {
    render();
    expect(shown(bench())).toBe(true);
    click(byName('Maximise'));
    expect(agentPane.getState().mode).toBe('max');
    expect(shown(bench())).toBe(false);
    expect(shown(host.querySelector('[role="tablist"]'))).toBe(true);
    expect(shown(input())).toBe(true);
    // the divider has nothing to divide while the agent has the whole panel
    expect(shown(host.querySelector('[role="separator"]'))).toBe(false);
    click(byName('Restore'));
    expect(agentPane.getState().mode).toBe('normal');
    expect(shown(bench())).toBe(true);
  });

  it('minimise folds the agent to one line that asks about the bound view', () => {
    render();
    click(byName('Minimise'));
    expect(shown(input())).toBe(false);
    expect(shown(bench())).toBe(true);
    const line = byName('Ask about');
    expect(line?.textContent).toContain('Ask about 3D view');
    expect(line?.textContent).toContain('Ctrl J');
    click(line);
    expect(agentPane.getState().mode).toBe('normal');
    expect(document.activeElement).toBe(input());
  });

  it('a tool start minimises the agent, and its stop brings it back', () => {
    const pane = createAgentPaneStore();
    const bench = createWorkbenchStore(null);
    const stop = startAgentPaneFollow(pane, bench, createSplitPrefs(null));
    bench.getState().toolStarted('measure');
    expect(pane.getState().mode).toBe('min');
    bench.getState().toolStopped('measure');
    expect(pane.getState().mode).toBe('normal');
    // from maximised, back to maximised
    pane.getState().setMode('max');
    bench.getState().toolStarted('measure');
    expect(pane.getState().mode).toBe('min');
    bench.getState().toolStopped('measure');
    expect(pane.getState().mode).toBe('max');
    stop();
  });

  it('a tool start shows the one line in the sidebar', () => {
    render();
    const bench = createWorkbenchStore(null);
    const stopLocal = startAgentPaneFollow(agentPane, bench);
    act(() => {
      bench.getState().toolStarted('annotate');
    });
    expect(shown(input())).toBe(false);
    expect(shown(byName('Ask about'))).toBe(true);
    act(() => {
      bench.getState().toolStopped('annotate');
    });
    expect(shown(input())).toBe(true);
    stopLocal();
  });

  it('after a manual resize a tool start leaves the agent as it is', () => {
    const pane = createAgentPaneStore();
    const bench = createWorkbenchStore(null);
    const prefs = createSplitPrefs(null);
    const stop = startAgentPaneFollow(pane, bench, prefs);
    prefs.getState().save(CTX_AGENT, { size: 0.45 });
    expect(pane.getState().userSized).toBe(true);
    bench.getState().toolStarted('measure');
    expect(pane.getState().mode).toBe('normal');
    bench.getState().toolStopped('measure');
    // the double-click reset is no sizing: tools fold the agent again
    prefs.getState().save(CTX_AGENT, { size: AGENT_SPLIT_DEFAULT, collapsed: false });
    expect(pane.getState().userSized).toBe(false);
    bench.getState().toolStarted('measure');
    expect(pane.getState().mode).toBe('min');
    stop();
  });

  it('the divider moved by the keyboard counts as a manual resize; a double-click resets 60 / 40', () => {
    const stop = startAgentPaneFollow();
    render();
    const divider = host.querySelector<HTMLElement>('[role="separator"]');
    expect(divider?.getAttribute('aria-label')).toBe('Resize the agent');
    act(() => {
      divider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(splitPrefs.getState().byId[CTX_AGENT]).toBeDefined();
    expect(agentPane.getState().userSized).toBe(true);
    act(() => {
      divider?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(splitPrefs.getState().byId[CTX_AGENT]?.size).toBe(AGENT_SPLIT_DEFAULT);
    expect(agentPane.getState().userSized).toBe(false);
    stop();
  });

  it('with the AI off the agent is one row, Agent off · Turn on, until it is clicked', async () => {
    await setReady(false);
    render();
    const row = byName('Agent off');
    expect(row?.textContent).toBe('Agent off · Turn on');
    expect(shown(row)).toBe(true);
    expect(shown(input())).toBe(false);
    expect(shown(host.querySelector('[role="separator"]'))).toBe(false);
    click(row);
    expect(shown(input())).toBe(true);
    expect(byName('Agent off')).toBeUndefined();
  });

  it('Ctrl+J opens a folded sidebar and a minimised agent, and puts the cursor in its input', () => {
    expect(
      matchShortcut('global', {
        key: 'j',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe('global.agent');
    render();
    act(() => {
      agentPane.getState().setMode('min');
      shell.setState({ rightCollapsed: true });
    });
    expect(shown(input())).toBe(false);
    act(() => {
      openAgent();
    });
    expect(shell.getState().rightCollapsed).toBe(false);
    expect(agentPane.getState().mode).toBe('normal');
    expect(document.activeElement).toBe(input());
  });
});
