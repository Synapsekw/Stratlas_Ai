import { defaultToolContext } from '@aio/ai';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpWindow, runMcpCall, startMcpBridge } from './mcpBridge';

const manifest = {
  name: 'Quarry',
  layers: [{ id: 'm1', kind: 'mesh', name: 'Mesh one', path: 'layers/m1.glb' }],
} as unknown as ProjectManifest;

beforeEach(() => {
  workspace.setState({
    project: { id: 'p1', root: 'C:/p', manifest },
    hidden: {},
    issues: [],
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
});

const call = (name: string, input: unknown = {}, projectId = 'p1') => ({
  callId: 'c1',
  projectId,
  name,
  input,
});

describe('runMcpCall', () => {
  it("runs a read tool with the agent's executor and answers its result as JSON", async () => {
    const r = await runMcpCall(call('list_layers'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callId).toBe('c1');
    expect(r.text).toContain('Mesh one');
  });

  it('never runs a write, navigate or send tool', async () => {
    const context = vi.fn(defaultToolContext);
    for (const name of ['create_issue_draft', 'fly_to', 'capture_frame', 'run_action']) {
      const r = await runMcpCall(call(name), context);
      expect(r).toEqual({ callId: 'c1', ok: false, error: `Unknown tool "${name}".` });
    }
    expect(context).not.toHaveBeenCalled();
  });

  it('refuses when another project is open than the one main checked', async () => {
    const r = await runMcpCall(call('list_layers', {}, 'p2'));
    expect(r).toMatchObject({ ok: false, error: 'That project is no longer open in the app.' });
  });

  it('drops the result when another project opened during the call', async () => {
    const r = await runMcpCall(call('list_layers'), (window) => {
      const ctx = defaultToolContext(window);
      workspace.setState({
        project: { id: 'p2', root: 'C:/q', manifest },
      } as unknown as Partial<ReturnType<typeof workspace.getState>>);
      return ctx;
    });
    expect(r).toMatchObject({ ok: false, error: 'That project is no longer open in the app.' });
  });

  it('answers a tool failure as an error', async () => {
    const r = await runMcpCall(call('list_issues', { status: 'nope' }));
    expect(r.ok).toBe(false);
  });
});

describe('mcpWindow', () => {
  it('runs in the 3D view unless the tool is offered elsewhere only', () => {
    expect(mcpWindow('list_layers')).toBe('scene3d');
    expect(mcpWindow('list_model_parts')).toBe('scene3d');
  });
});

describe('startMcpBridge', () => {
  it('answers each call with mcp:result, and does nothing without the app bridge', async () => {
    const stop = startMcpBridge(undefined);
    expect(typeof stop).toBe('function');
    let listener: ((c: ReturnType<typeof call>) => void) | null = null;
    const invoke = vi.fn(() => Promise.resolve({ ok: true }));
    const aio = {
      on: (_e: string, l: typeof listener) => {
        listener = l;
        return () => undefined;
      },
      invoke,
    };
    startMcpBridge(aio as never);
    expect(listener).not.toBeNull();
    (listener as unknown as (c: ReturnType<typeof call>) => void)(call('list_layers'));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
    expect(invoke).toHaveBeenCalledWith('mcp:result', expect.objectContaining({ ok: true }));
  });
});
