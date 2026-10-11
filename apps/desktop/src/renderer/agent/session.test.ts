// @vitest-environment jsdom
import type {
  AioBridge,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  ProjectManifest,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { appAgentSession, setAgentTask, setAgentWindow, startAgentSession } from './session';

interface Call {
  channel: IpcChannel;
  req: unknown;
}

/** A main process whose agent is ready and whose projects allow sending without the preview. */
function fakeBridge() {
  const calls: Call[] = [];
  let listener: ((e: IpcEvent<'ai:event'>) => void) | null = null;
  const route = { task: 'chat' as const, provider: 'openai' as const, model: 'gpt-5' };
  const bridge: AioBridge = {
    invoke: <C extends IpcChannel>(channel: C, req: IpcRequest<C>) => {
      calls.push({ channel, req });
      const answer: Partial<Record<IpcChannel, unknown>> = {
        'ai:status': { ready: true, route, cloud: true },
        'ai:project': { alwaysAllow: true, policy: 'allow', usage: [] },
        'ai:send': { ok: true },
        'ai:toolResult': { ok: true },
        'ai:cancel': { ok: true },
        'ai:saveConversation': { ok: true },
      };
      return Promise.resolve(answer[channel] as IpcResponse<C>);
    },
    on: (_event, l) => {
      listener = l as (e: IpcEvent<'ai:event'>) => void;
      return () => {
        listener = null;
      };
    },
  };
  const sent = <C extends IpcChannel>(channel: C) =>
    calls.filter((c) => c.channel === channel).map((c) => c.req as IpcRequest<C>);
  return {
    bridge,
    sent,
    listening: () => listener !== null,
    forget: () => {
      calls.length = 0;
    },
  };
}

// The app has one session, made on the bridge that is there at its first use: one bridge for the
// file (sessionNoBridge.test.ts is the app without one).
const b = fakeBridge();
(globalThis as { aio?: AioBridge }).aio = b.bridge;

const manifest = (id: string): ProjectManifest => ({
  schema: 'aio.project/1',
  id,
  name: `Tank farm ${id}`,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});
const project = (id: string) => ({ id, root: `E:/projects/${id}`, manifest: manifest(id) });

const session = appAgentSession();
const ready = () =>
  vi.waitFor(() => {
    expect(session.getState().availability.status).toBe('ready');
  });

let stop: (() => void) | undefined;
beforeEach(() => {
  b.forget();
  shell.getState().go('scene');
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  workspace.getState().closeProject();
  session.reset();
  await session.settled();
  setAgentWindow('scene3d');
  setAgentTask(undefined);
});

/** The app running with project `a` open and a first message sent: a reply is on its way. */
async function talking() {
  stop = startAgentSession();
  workspace.getState().openProject(project('a'));
  await ready();
  await session.send('Show the worst finding');
  expect(session.getState().turns).toHaveLength(2);
  expect(session.getState().busy).toBe(true);
}

describe('the one agent session of the app', () => {
  it('is made on first use and stays the same object', () => {
    expect(appAgentSession()).toBe(session);
    expect(appAgentSession()).toBe(session);
  });

  it('listens to the agent from the start and keeps the conversation as screens change', async () => {
    expect(b.listening()).toBe(false);
    await talking();
    expect(b.listening()).toBe(true);
    // another screen binds the agent to its window: the conversation is the same one
    setAgentWindow('photo');
    setAgentWindow('issues');
    expect(session.getState().turns).toHaveLength(2);
    expect(session.getState().busy).toBe(true);
    expect(b.sent('ai:cancel')).toHaveLength(0);
  });

  it('lets a reply run on while the screen changes to one that shows the agent', async () => {
    await talking();
    for (const screen of ['media', 'issues', 'detections', 'reports', 'scene'] as const) {
      shell.getState().go(screen);
      expect(b.sent('ai:cancel'), screen).toHaveLength(0);
      expect(session.getState().busy, screen).toBe(true);
    }
  });

  it('stops a reply when the screen changes to one with no agent and no Stop', async () => {
    await talking();
    // from Scene and from a screen with the agent column alike
    const leaving = [
      ['scene', 'settings'],
      ['media', 'globe'],
      ['issues', 'projects'],
      ['reports', 'welcome'],
    ] as const;
    for (const [n, [from, to]] of leaving.entries()) {
      shell.getState().go(from);
      if (!session.getState().busy) await session.send('And the next one');
      expect(session.getState().busy, from).toBe(true);
      expect(b.sent('ai:cancel'), from).toHaveLength(n);

      shell.getState().go(to);

      expect(b.sent('ai:cancel'), to).toHaveLength(n + 1);
      expect(session.getState().busy, to).toBe(false);
    }
    // the conversation is kept: the person finds it when they come back
    expect(session.getState().turns).toHaveLength(2 * leaving.length);
    expect(session.getState().turns.at(-1)).toMatchObject({ kind: 'assistant', status: 'stopped' });
  });

  it('leaves a quiet conversation alone on those screens', async () => {
    stop = startAgentSession();
    workspace.getState().openProject(project('a'));
    await ready();
    shell.getState().go('settings');
    shell.getState().go('scene');
    expect(b.sent('ai:cancel')).toHaveLength(0);
  });

  it('starts a new conversation when another project opens', async () => {
    await talking();
    const asked = b.sent('ai:status').length;

    workspace.getState().openProject(project('b'));

    expect(session.getState().turns).toEqual([]);
    expect(session.getState().steps).toEqual({});
    expect(session.getState().id).toBe('');
    expect(session.getState().busy).toBe(false);
    // the reply that was running is stopped, and the route is checked for the new project
    expect(b.sent('ai:cancel')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(b.sent('ai:status').length).toBeGreaterThan(asked);
    });
    expect(b.sent('ai:status').at(-1)).toEqual({ projectId: 'b' });
  });

  it('saves the conversation it leaves into the project it was held in', async () => {
    await talking();

    workspace.getState().openProject(project('b'));
    await session.settled();

    const saves = b.sent('ai:saveConversation');
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.map((s) => s.projectId)).not.toContain('b');
    expect(saves.at(-1)?.projectId).toBe('a');
    expect(saves.at(-1)?.conversation.turns).toHaveLength(2);
  });

  it('keeps the conversation when the open project is only read again', async () => {
    await talking();

    workspace.getState().replaceManifest({ ...manifest('a'), name: 'Renamed' });
    workspace.getState().openProject(project('a'));

    expect(session.getState().turns).toHaveLength(2);
    expect(b.sent('ai:cancel')).toHaveLength(0);
  });

  it('resets when the project closes, saving into the project that was open', async () => {
    await talking();

    workspace.getState().closeProject();
    await session.settled();

    expect(session.getState().turns).toEqual([]);
    expect(b.sent('ai:saveConversation').at(-1)?.projectId).toBe('a');
  });

  it('sends with the window and the task the screen set', async () => {
    stop = startAgentSession();
    workspace.getState().openProject(project('a'));
    await ready();

    setAgentWindow('issues');
    setAgentTask('build');
    await session.send('Which findings are open?');
    expect(b.sent('ai:send').at(-1)).toMatchObject({ window: 'issues', task: 'build' });

    session.reset();
    setAgentWindow('photo');
    setAgentTask(undefined);
    await session.send('Show the photos');
    const last = b.sent('ai:send').at(-1);
    expect(last).toMatchObject({ window: 'photo' });
    expect(last).not.toHaveProperty('task');
  });

  it('checks the route again when the window gets the focus', () => {
    stop = startAgentSession();
    const asked = b.sent('ai:status').length;
    window.dispatchEvent(new Event('focus'));
    expect(b.sent('ai:status')).toHaveLength(asked + 1);
  });

  it('stops listening and following the project when stopped', async () => {
    const end = startAgentSession();
    workspace.getState().openProject(project('a'));
    await ready();
    end();
    expect(b.listening()).toBe(false);
    const asked = b.sent('ai:status').length;
    workspace.getState().openProject(project('b'));
    window.dispatchEvent(new Event('focus'));
    expect(b.sent('ai:status')).toHaveLength(asked);
    // nor does it follow the screen any more
    await session.send('Show the worst finding');
    expect(session.getState().busy).toBe(true);
    shell.getState().go('settings');
    expect(b.sent('ai:cancel')).toHaveLength(0);
  });
});
