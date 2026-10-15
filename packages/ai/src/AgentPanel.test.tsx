// @vitest-environment jsdom
import type {
  AioBridge,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  WindowKind,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPanel,
  describeStep,
  type AgentFixControls,
  type AgentPanelProps,
} from './AgentPanel';
import { OFFLINE_ONLY_MESSAGE } from './errors';
import { defaultToolContext } from './renderer-tools';
import { AgentSession } from './session';
import { fixtureIssue, fixtureManifest } from './test-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  delete (globalThis as { aio?: AioBridge }).aio;
  workspace.getState().closeProject();
});

async function render(bridge: AioBridge | null, props: Partial<AgentPanelProps> = {}) {
  if (bridge) (globalThis as { aio?: AioBridge }).aio = bridge;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<AgentPanel window="scene3d" {...props} />);
    await Promise.resolve();
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return host;
}

function bridge(cloudAi: boolean, alwaysAllow = true) {
  const sent: IpcRequest<'ai:send'>[] = [];
  const cancelled: IpcRequest<'ai:cancel'>[] = [];
  let listener: ((e: IpcEvent<'ai:event'>) => void) | null = null;
  const b: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      if (channel === 'ai:send') sent.push(req as IpcRequest<'ai:send'>);
      if (channel === 'ai:cancel') cancelled.push(req as IpcRequest<'ai:cancel'>);
      const route = { task: 'chat', provider: 'anthropic', model: 'claude-sonnet-5-5' };
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'ai:status': cloudAi
          ? { ready: true, route, cloud: true }
          : {
              ready: false,
              reason: 'cloud-off',
              message: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
              cloud: true,
              route,
            },
        'ai:project': {
          alwaysAllow,
          policy: 'allow',
          usage: [
            {
              provider: 'anthropic',
              inputTokens: 100_000,
              outputTokens: 2_000,
              costUsd: 1.5,
              costKnown: true,
            },
          ],
        },
        'ai:send': { ok: true },
        'ai:listConversations': { ok: true, conversations: [] },
      };
      return Promise.resolve((answer[channel] ?? { ok: true }) as IpcResponse<C>);
    },
    on: (_e, l) => {
      listener = l as (e: IpcEvent<'ai:event'>) => void;
      return () => {
        listener = null;
      };
    },
  };
  return { b, sent, cancelled, emit: (e: IpcEvent<'ai:event'>) => listener?.(e) };
}

/** A session the app owns, connected and holding one question. */
async function ownedSession(bridge: AioBridge, win: WindowKind = 'scene3d') {
  const session = new AgentSession({
    bridge,
    window: win,
    toolContext: () => defaultToolContext(win),
  });
  session.connect();
  await session.refresh();
  await session.send('Which clips are open?');
  return session;
}

/** Mount the panel on the host from `render`, after it was unmounted. */
async function remount(props: Partial<AgentPanelProps>) {
  if (!host) throw new Error('render the panel first');
  root = createRoot(host);
  await act(async () => {
    root?.render(<AgentPanel window="scene3d" {...props} />);
    await Promise.resolve();
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

describe('AgentPanel', () => {
  it('explains that the agent needs the desktop app', async () => {
    const el = await render(null);
    expect(el.textContent).toContain('The agent runs in the desktop app.');
  });

  it('explains how to turn on cloud AI', async () => {
    const el = await render(bridge(false).b);
    expect(el.textContent).toContain('Cloud AI is off');
    expect(el.querySelector('textarea')?.disabled).toBe(true);
  });

  it('says cloud AI is off because the workstation is offline-only', async () => {
    const base = bridge(false).b;
    const b: AioBridge = {
      invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) =>
        channel === 'ai:status'
          ? Promise.resolve({
              ready: false,
              reason: 'offline-only',
              message: OFFLINE_ONLY_MESSAGE,
              cloud: true,
            } as IpcResponse<C>)
          : base.invoke(channel, req),
      on: (event, listener) => base.on(event, listener),
    };
    const el = await render(b);
    const off = el.querySelector('.ag-off')?.textContent ?? '';
    expect(off).toContain('Cloud AI is off because this workstation is offline-only.');
    expect(off).toContain('turn off Offline-only workstation in Settings, Privacy and cloud');
    // not the steps for the cloud switch: turning it on would change nothing
    expect(off).not.toContain('Switch on Allow cloud AI');
    expect(el.querySelector('textarea')?.disabled).toBe(true);
  });

  it('checks its route again when the AI settings change', async () => {
    let current = bridge(false).b;
    const b: AioBridge = {
      invoke: (channel, req) => current.invoke(channel, req),
      on: (event, listener) => current.on(event, listener),
    };
    const el = await render(b, { settingsKey: 'off' });
    expect(el.textContent).toContain('Cloud AI is off');
    // cloud AI turned on from the palette: no focus change, a new settings key
    current = bridge(true).b;
    await act(async () => {
      root?.render(<AgentPanel window="scene3d" settingsKey="on" />);
      await Promise.resolve();
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(el.textContent).not.toContain('Cloud AI is off');
    expect(el.querySelector('textarea')?.disabled).toBe(false);
  });

  it('shows the binding chip and the suggestions the project can answer, and sends one', async () => {
    workspace
      .getState()
      .openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [fixtureIssue()]);
    workspace.getState().select({ kind: 'asset', id: '20-T-0002' });
    const t = bridge(true);
    const el = await render(t.b);
    expect(el.querySelector('.ag-bind')?.textContent).toBe('3D view, 20-T-0002, 15:11:00');
    const suggestions = el.querySelectorAll<HTMLButtonElement>('.ag-sug');
    // no photos in this project, so the photo request is left out
    expect([...suggestions].map((b) => b.textContent)).toEqual([
      'Take me to the most severe finding',
      'Which asset has the most findings?',
      'Which clips fly within 40 m of the selected asset?',
      'Fly to the most severe open issue',
    ]);
    await act(async () => {
      suggestions[0]?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.sent[0]?.messages[0]?.content).toBe(suggestions[0]?.textContent);
    await act(async () => {
      t.emit({ type: 'text', runId: t.sent[0]?.runId ?? '', delta: 'Two clips.' });
      t.emit({
        type: 'usage',
        runId: t.sent[0]?.runId ?? '',
        inputTokens: 12_000,
        outputTokens: 400,
        costUsd: 0.04,
      });
      t.emit({ type: 'done', runId: t.sent[0]?.runId ?? '' });
      await Promise.resolve();
    });
    expect(el.textContent).toContain('Two clips.');
    expect(el.textContent).toContain('12.4k tok · $0.04');
    expect(el.textContent).toContain('Claude Sonnet 5.5');
  });

  it('invites a question about the window in words that fit it', async () => {
    workspace
      .getState()
      .openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, [fixtureIssue()]);
    // the agent column of Media is bound to the photos, that of Issues to the issues
    const el = await render(bridge(true).b, { window: 'photo' });
    expect(el.querySelector('.ag-empty p')?.textContent).toBe(
      'Ask about these photos or tell the agent what to do.',
    );
  });
});

describe('AgentPanel fixes in place', () => {
  it('renders the app card under a reply that failed with a fixable error, and retries', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    let controls: AgentFixControls | null = null;
    const el = await render(t.b, {
      renderFix: (c) => {
        controls = c;
        return <div data-testid="fix">{c.fix.code}</div>;
      },
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('.ag-sug')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      t.emit({
        type: 'error',
        runId: t.sent[0]?.runId ?? '',
        message: 'Anthropic: not scoped to a workspace. (HTTP 400)',
        code: 'anthropic-workspace',
      });
      await Promise.resolve();
    });
    expect(el.querySelector('.ag-err')?.textContent).toContain('not scoped to a workspace');
    expect(el.querySelector('[data-testid="fix"]')?.textContent).toBe('anthropic-workspace');
    await act(async () => {
      await controls?.retry();
    });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.messages).toEqual(t.sent[0]?.messages);
    expect(el.querySelector('[data-testid="fix"]')).toBeNull();
    expect(el.querySelector('.ag-err')).toBeNull();
  });
});

describe('AgentPanel send preview', () => {
  it('shows provider, model, text and context before the first send, then sends', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true, false);
    const el = await render(t.b);
    expect(el.textContent).toContain('102.0k tok · $1.50');
    await act(async () => {
      el.querySelector<HTMLButtonElement>('.ag-sug')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Anthropic');
    expect(dialog?.textContent).toContain('claude-sonnet-5-5');
    expect(dialog?.textContent).toContain('Tank farm');
    expect(t.sent).toHaveLength(0);
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('button.primary')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.sent).toHaveLength(1);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('AgentPanel with a session the app owns', () => {
  it('shows the conversation the session already holds, without resetting it', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    const el = await render(t.b, { session });
    expect(el.textContent).toContain('Which clips are open?');
    expect(session.getState().turns).toHaveLength(2);
  });

  it('keeps the conversation when the panel is unmounted and mounted again', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    const el = await render(t.b, { session });
    act(() => {
      root?.unmount();
    });
    expect(el.textContent).toBe('');
    await remount({ session });
    expect(el.textContent).toContain('Which clips are open?');
  });

  it('does not stop a running reply when the panel goes away', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    expect(session.getState().busy).toBe(true);
    await render(t.b, { session });
    act(() => {
      root?.unmount();
    });
    expect(t.cancelled).toHaveLength(0);
    expect(session.getState().busy).toBe(true);
  });

  it('keeps the conversation when the project changes: the owner resets it', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    const el = await render(t.b, { session });
    await act(async () => {
      workspace.getState().openProject({ id: 'p2', root: 'E:/y', manifest: fixtureManifest() }, []);
      await Promise.resolve();
    });
    expect(el.textContent).toContain('Which clips are open?');
  });

  it('still tells the session its window and checks the route on a settings change', async () => {
    let current = bridge(false).b;
    const b: AioBridge = {
      invoke: (channel, req) => current.invoke(channel, req),
      on: (event, listener) => current.on(event, listener),
    };
    const session = new AgentSession({
      bridge: b,
      window: 'scene3d',
      toolContext: () => defaultToolContext('scene3d'),
    });
    const setWindow = vi.spyOn(session, 'setWindow');
    const el = await render(b, { session, settingsKey: 'off' });
    expect(setWindow).toHaveBeenCalledWith('scene3d');
    expect(el.textContent).toContain('Cloud AI is off');
    // cloud AI turned on from the palette: a new settings key, the shown session checks again
    current = bridge(true).b;
    await act(async () => {
      root?.render(<AgentPanel window="photo" session={session} settingsKey="on" />);
      await Promise.resolve();
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(setWindow).toHaveBeenLastCalledWith('photo');
    expect(el.textContent).not.toContain('Cloud AI is off');
    expect(el.querySelector('textarea')?.disabled).toBe(false);
  });

  it('says why the agent is off under a conversation it kept', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    let current = bridge(true).b;
    const b: AioBridge = {
      invoke: (channel, req) => current.invoke(channel, req),
      on: (event, listener) => current.on(event, listener),
    };
    const session = await ownedSession(b);
    const el = await render(b, { session });
    expect(el.querySelector('.ag-off')).toBeNull();
    // cloud AI is switched off past the panel, and the person comes back from another screen: the
    // conversation is still there, so the reason has to be said beside it, not instead of it
    current = bridge(false).b;
    act(() => {
      root?.unmount();
    });
    await remount({ session });
    expect(el.textContent).toContain('Which clips are open?');
    expect(el.querySelector('.ag-off')?.textContent).toContain('Cloud AI is off');
    expect(el.querySelector('textarea')?.disabled).toBe(true);
  });

  it('without the prop each mount gets a fresh conversation', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const el = await render(t.b);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('.ag-sug')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.querySelectorAll('.ag-msg.user')).toHaveLength(1);
    act(() => {
      root?.unmount();
    });
    await remount({});
    expect(el.querySelectorAll('.ag-msg.user')).toHaveLength(0);
    // and unmounting a busy panel it owns still cancels the run
    expect(t.cancelled).toHaveLength(1);
  });
});

describe('describeStep', () => {
  it('says what an approval will do', () => {
    expect(
      describeStep({ name: 'create_issue_draft', input: { title: 'Rust', severity: 3 } }),
    ).toBe('Adds draft issue "Rust", severity 3');
    expect(describeStep({ name: 'capture_frame', input: {} })).toBe(
      'Sends the current frame to the AI provider',
    );
  });
});

describe('describeStep for propose_class', () => {
  it('asks to create the named class', () => {
    expect(describeStep({ name: 'propose_class', input: { label: 'Spalling' } })).toBe(
      "Create class 'Spalling'?",
    );
  });
});
