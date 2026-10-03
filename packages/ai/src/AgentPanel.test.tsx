// @vitest-environment jsdom
import type { AioBridge, IpcChannel, IpcEvent, IpcRequest, IpcResponse } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPanel, describeStep } from './AgentPanel';
import { fixtureManifest } from './test-fixtures';

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

async function render(bridge: AioBridge | null) {
  if (bridge) (globalThis as { aio?: AioBridge }).aio = bridge;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<AgentPanel window="scene3d" />);
    await Promise.resolve();
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return host;
}

function bridge(cloudAi: boolean) {
  const sent: IpcRequest<'ai:send'>[] = [];
  let listener: ((e: IpcEvent<'ai:event'>) => void) | null = null;
  const b: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      if (channel === 'ai:send') sent.push(req as IpcRequest<'ai:send'>);
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'settings:get': {
          cloudAi,
          theme: 'dark',
          sidebarCollapsed: false,
          dataRoot: 'E:/data',
          routes: [{ task: 'chat', provider: 'anthropic', model: 'claude-sonnet-5-5' }],
        },
        'ai:hasKey': { present: true },
        'ai:send': { ok: true },
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
  return { b, sent, emit: (e: IpcEvent<'ai:event'>) => listener?.(e) };
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

  it('shows the binding chip and three suggestions, and sends one', async () => {
    workspace.getState().openProject({ id: 'p1', root: 'E:/x', manifest: fixtureManifest() }, []);
    workspace.getState().select({ kind: 'asset', id: '20-T-0002' });
    const t = bridge(true);
    const el = await render(t.b);
    expect(el.querySelector('.ag-bind')?.textContent).toBe('3D view, 20-T-0002, 15:11:00');
    const suggestions = el.querySelectorAll<HTMLButtonElement>('.ag-sug');
    expect(suggestions).toHaveLength(3);
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
