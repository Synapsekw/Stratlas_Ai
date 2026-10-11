// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { appAgentSession, startAgentSession } from './session';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  workspace.getState().closeProject();
});

// A test that renders a screen has no `window.aio`: the session must still be there to show.
describe('the agent session without the app bridge', () => {
  it('is made all the same and says the agent is off', async () => {
    expect((globalThis as { aio?: unknown }).aio).toBeUndefined();
    const session = appAgentSession();
    expect(appAgentSession()).toBe(session);
    await session.refresh();
    expect(session.getState().availability).toMatchObject({
      status: 'disabled',
      reason: 'no-bridge',
    });
  });

  it('starts, follows the project and stops without throwing', () => {
    stop = startAgentSession();
    workspace.getState().openProject({
      id: 'p1',
      root: 'E:/projects/p1',
      manifest: {
        schema: 'aio.project/1',
        id: 'p1',
        name: 'Tank farm',
        crs: { epsg: 32639 },
        origin: [0, 0, 0],
        captures: [],
        layers: [],
        severityModels: [],
        classCatalogues: [],
      },
    });
    window.dispatchEvent(new Event('focus'));
    expect(appAgentSession().getState().turns).toEqual([]);
  });
});
