// @vitest-environment jsdom
import type {
  AgentNote,
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
import { registerStepDescriber } from './tool-kit';
import { defaultToolContext } from './renderer-tools';
import { AgentSession, resetPreviewMemory } from './session';
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
    expect(t.sent[0]?.messages[0]).toEqual({ role: 'user', content: suggestions[0]?.textContent });
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

describe('describeStep with a describer the app registers', () => {
  it('uses it for that tool, and falls back when it answers nothing or throws', () => {
    const off = registerStepDescriber('run_action', (input) =>
      (input as { action?: string }).action === 'boom'
        ? (() => {
            throw new Error('x');
          })()
        : (input as { action?: string }).action === 'layer.delete'
          ? 'Delete Outline (4 Sep 2024)'
          : null,
    );
    try {
      expect(describeStep({ name: 'run_action', input: { action: 'layer.delete' } })).toBe(
        'Delete Outline (4 Sep 2024)',
      );
      const fallback = describeStep({ name: 'run_action', input: { action: 'x' } });
      expect(fallback).toMatch(/menu action/);
      expect(describeStep({ name: 'run_action', input: { action: 'boom' } })).toBe(fallback);
    } finally {
      off();
    }
    expect(describeStep({ name: 'run_action', input: { action: 'layer.delete' } })).toMatch(
      /menu action/,
    );
  });
});

describe('describeStep for the placement tools', () => {
  it('says how many findings go on which layer, and where a sighting is added', () => {
    expect(
      describeStep({ name: 'place_on_model', input: { ids: ['F01', 'F02'], layer: 'Site model' } }),
    ).toBe('Place 2 findings on Site model');
    expect(describeStep({ name: 'place_on_model', input: { ids: ['F01'], layer: 'cloud' } })).toBe(
      'Place 1 finding on cloud',
    );
    expect(
      describeStep({
        name: 'add_sighting',
        input: { issue: 'F05', layer: 'Site model', at: { kind: 'point', p: [0, 0, 0] } },
      }),
    ).toBe('Add a place to F05 on Site model');
  });
});

describe('batch approvals and view capture in the panel (A3)', () => {
  const draft = (title: string) => ({
    title,
    severity: 3,
    classId: 'corrosion',
    at: { kind: 'point', p: [0, 0, 0] },
  });

  async function withCalls(calls: { callId: string; name: string; input: unknown }[]) {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    const el = await render(t.b, { session });
    const runId = t.sent[0]?.runId ?? '';
    await act(async () => {
      for (const c of calls) {
        t.emit({
          type: 'tool-call',
          runId,
          callId: c.callId,
          name: c.name,
          input: c.input,
          risk: c.name === 'capture_frame' ? 'send' : 'write',
        });
      }
      await Promise.resolve();
    });
    return { el, session, t };
  }

  const only = (el: HTMLElement, selector: string): HTMLElement => {
    const found = el.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`nothing matches ${selector}`);
    return found;
  };

  const button = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

  it('shows one card for several waiting writes, each ticked, and approves the ticked ones', async () => {
    const { el, session } = await withCalls([
      { callId: 'b1', name: 'create_issue_draft', input: draft('One') },
      { callId: 'b2', name: 'create_issue_draft', input: draft('Two') },
      { callId: 'b3', name: 'create_issue_draft', input: draft('Three') },
    ]);
    const cards = el.querySelectorAll('.approve');
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    expect(card.textContent).toContain('3 actions waiting for you');
    const boxes = [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true]);
    expect(card.textContent).toContain('Adds draft issue "Two", severity 3');
    // each step keeps its own row and chip
    expect(el.querySelectorAll('.step.awaiting')).toHaveLength(3);
    act(() => {
      boxes[1]?.click();
    });
    expect(button(card, 'Approve 2')).toBeTruthy();
    const spy = vi.spyOn(session, 'approveBatch').mockResolvedValue();
    act(() => {
      button(card, 'Approve 2')?.click();
    });
    expect(spy).toHaveBeenCalledWith(['b1', 'b3'], ['b2']);
    act(() => {
      button(card, 'Reject all')?.click();
    });
    expect(spy).toHaveBeenLastCalledWith([], ['b1', 'b2', 'b3']);
  });

  it('cannot approve a batch with nothing ticked', async () => {
    const { el } = await withCalls([
      { callId: 'b1', name: 'create_issue_draft', input: draft('One') },
      { callId: 'b2', name: 'create_issue_draft', input: draft('Two') },
    ]);
    const card = only(el, '.approve');
    for (const b of card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      act(() => {
        b.click();
      });
    }
    expect(button(card, 'Approve 0')?.disabled).toBe(true);
  });

  it('keeps the single card for one waiting write', async () => {
    const { el } = await withCalls([
      { callId: 'b1', name: 'create_issue_draft', input: draft('One') },
    ]);
    const cards = el.querySelectorAll('.approve');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelector('input')).toBeNull();
    expect(button(cards[0] as HTMLElement, 'Approve')).toBeTruthy();
  });

  it('offers to allow view capture for the project on the capture card', async () => {
    const { el, session } = await withCalls([{ callId: 'f1', name: 'capture_frame', input: {} }]);
    const card = only(el, '.approve');
    expect([...card.querySelectorAll('button')].map((b) => b.textContent.trim())).toEqual([
      'Reject',
      'Just this once',
      'Allow for this project',
    ]);
    const spy = vi.spyOn(session, 'approve').mockResolvedValue(true);
    act(() => {
      button(card, 'Allow for this project')?.click();
    });
    expect(spy).toHaveBeenCalledWith('f1', { allowViewCapture: true });
    act(() => {
      button(card, 'Just this once')?.click();
    });
    expect(spy).toHaveBeenLastCalledWith('f1');
  });

  it('says under a capture that it ran because the project allows it', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = bridge(true);
    const session = await ownedSession(t.b);
    const el = await render(t.b, { session });
    await act(async () => {
      await session.setViewCapture(true);
    });
    await act(async () => {
      t.emit({
        type: 'tool-call',
        runId: t.sent[0]?.runId ?? '',
        callId: 'f1',
        name: 'capture_frame',
        input: {},
        risk: 'send',
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.querySelector('.approve')).toBeNull();
    expect(el.querySelector('.step-note')?.textContent).toBe(
      'Ran without asking: view capture is allowed for this project.',
    );
  });
});

describe('the project panel (A3)', () => {
  const pile = {
    id: 'n-pile1',
    text: 'The piles here are named SP-1 to SP-9',
    by: 'agent' as const,
    createdAt: '2026-11-01T09:00:00.000Z',
  };

  /** Main's note store and the A3 switches, in memory, over the panel test bridge. */
  interface PanelOpts {
    readOnly?: boolean;
    alwaysAllow?: boolean;
    hold?: Promise<void>;
  }
  function projectBridge(opts: PanelOpts = {}) {
    const base = bridge(true, opts.alwaysAllow ?? false);
    let notes: AgentNote[] = [pile];
    const calls: { channel: IpcChannel; req: unknown }[] = [];
    const b: AioBridge = {
      invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
        calls.push({ channel, req });
        const answer = (v: unknown) => Promise.resolve(v as IpcResponse<C>);
        if (channel === 'ai:memory')
          return answer({ ok: true, notes, readOnly: opts.readOnly ?? false });
        if (channel === 'ai:remember') {
          const r = req as IpcRequest<'ai:remember'>;
          if (opts.hold) {
            const note = { id: 'n-held1', text: r.text, by: r.by, createdAt: pile.createdAt };
            return opts.hold.then(() => ({ ok: true, note }) as IpcResponse<C>);
          }
          if (r.text.trim() === pile.text) return answer({ ok: false, error: 'Already there.' });
          const note = { id: 'n-mine1', text: r.text, by: r.by, createdAt: pile.createdAt };
          notes = [...notes, note];
          return answer({ ok: true, note });
        }
        if (channel === 'ai:forget') {
          const id = (req as IpcRequest<'ai:forget'>).id;
          notes = notes.filter((n) => n.id !== id);
          return answer({ ok: true, note: pile });
        }
        return base.b.invoke(channel, req);
      },
      on: (event, listener) => base.b.on(event, listener),
    };
    return { b, calls };
  }

  async function openPanel(opts: PanelOpts = {}) {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const t = projectBridge(opts);
    const el = await render(t.b);
    const toggle = el.querySelector<HTMLButtonElement>(
      'button[aria-label="This project: notes and permissions"]',
    );
    if (!toggle) throw new Error('no project panel button');
    await act(async () => {
      toggle.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    return { el, t, toggle };
  }

  const buttonNamed = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

  it('opens from the header like the history, and lists the notes with who saved them', async () => {
    const { el, toggle } = await openPanel();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const list = el.querySelector('[aria-label="Notes"]');
    expect(list?.textContent).toContain('The piles here are named SP-1 to SP-9');
    expect(list?.textContent).toContain('Saved by Ask AI');
    expect(el.textContent).toContain('1 of 30');
  });

  it('waits while a note is being saved: no second add or delete meanwhile', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { el } = await openPanel({ hold });
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Add a note"]');
    if (!input) throw new Error('no add field');
    await act(async () => {
      Reflect.set(HTMLInputElement.prototype, 'value', 'Units are feet', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonNamed(el, 'Add')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(input.disabled).toBe(true);
    expect(buttonNamed(el, 'Add')?.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('button[aria-label^="Delete note"]')?.disabled).toBe(
      true,
    );
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(input.disabled).toBe(false);
  });

  it('adds a note for the person and deletes one', async () => {
    const { el, t } = await openPanel();
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Add a note"]');
    if (!input) throw new Error('no add field');
    await act(async () => {
      // React reads the value through the prototype's setter
      Reflect.set(HTMLInputElement.prototype, 'value', 'Units are feet', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonNamed(el, 'Add')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.calls.find((c) => c.channel === 'ai:remember')?.req).toMatchObject({
      projectId: 'p1',
      text: 'Units are feet',
      by: 'person',
    });
    expect(el.textContent).toContain('Added by you');
    expect(input.value).toBe('');
    const del = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete note: The piles here are named SP-1 to SP-9"]',
    );
    await act(async () => {
      del?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.calls.find((c) => c.channel === 'ai:forget')?.req).toMatchObject({ id: 'n-pile1' });
    expect(el.textContent).not.toContain('SP-1 to SP-9');
  });

  it('shows the notes of a read-only package without delete or add, and says why', async () => {
    const { el } = await openPanel({ readOnly: true });
    expect(el.textContent).toContain('SP-1 to SP-9');
    expect(el.textContent).toContain('cannot be changed here');
    expect(el.querySelector('button[aria-label^="Delete note"]')).toBeNull();
    expect(el.querySelector('input[aria-label="Add a note"]')).toBeNull();
  });

  it('turns view capture on per route, and stops sending without the preview', async () => {
    const { el, t } = await openPanel({ alwaysAllow: true });
    const local = el.querySelector<HTMLInputElement>(
      'input[aria-label="Look at the view without asking: on this computer"]',
    );
    const cloud = el.querySelector<HTMLInputElement>(
      'input[aria-label="Look at the view without asking: with cloud AI"]',
    );
    expect([local?.checked, cloud?.checked]).toEqual([false, false]);
    await act(async () => {
      local?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      cloud?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.calls.filter((c) => c.channel === 'ai:setViewCapture').map((c) => c.req)).toEqual([
      { projectId: 'p1', allow: true, cloud: false },
      { projectId: 'p1', allow: true, cloud: true },
    ]);
    expect([local?.checked, cloud?.checked]).toEqual([true, true]);
    await act(async () => {
      buttonNamed(el, 'Stop sending without the preview')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.calls.find((c) => c.channel === 'ai:setConsent')?.req).toEqual({
      projectId: 'p1',
      alwaysAllow: false,
    });
    expect(buttonNamed(el, 'Stop sending without the preview')).toBeUndefined();
  });
});

describe('the forget card (A3)', () => {
  it("names the note from the session's notes, not its id", () => {
    const note = {
      id: 'n-pile1',
      text: 'The piles are named SP-1 to SP-9',
      by: 'agent' as const,
      createdAt: '2026-11-01T09:00:00.000Z',
    };
    expect(describeStep({ name: 'forget_note', input: { id: 'n-pile1' } }, [note])).toBe(
      'Forget: The piles are named SP-1 to SP-9',
    );
  });
});

describe('the send preview shows the project notes (A3)', () => {
  it('lists projectNotes in the window context it shows', async () => {
    // an earlier test confirmed this project's preview during this run
    resetPreviewMemory();
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    const base = bridge(true, false);
    const b: AioBridge = {
      invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) =>
        channel === 'ai:memory'
          ? Promise.resolve({
              ok: true,
              notes: [
                {
                  id: 'n-pile1',
                  text: 'The piles are named SP-1 to SP-9',
                  by: 'person',
                  createdAt: '2026-11-01T09:00:00.000Z',
                },
              ],
              readOnly: false,
            } as IpcResponse<C>)
          : base.b.invoke(channel, req),
      on: (event, listener) => base.b.on(event, listener),
    };
    const session = new AgentSession({
      bridge: b,
      window: 'scene3d',
      toolContext: () => defaultToolContext('scene3d'),
    });
    session.connect();
    await session.refresh();
    const el = await render(b, { session });
    await act(async () => {
      await session.send('How are the piles named?');
    });
    const dialog = el.querySelector('[role="dialog"]') ?? document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('"projectNotes"');
    expect(dialog?.textContent).toContain('The piles are named SP-1 to SP-9');
  });
});

describe('describeStep for propose_class', () => {
  it('asks to create the named class', () => {
    expect(describeStep({ name: 'propose_class', input: { label: 'Spalling' } })).toBe(
      "Create class 'Spalling'?",
    );
  });
});
