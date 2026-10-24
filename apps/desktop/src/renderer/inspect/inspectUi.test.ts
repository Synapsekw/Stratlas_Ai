import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import { inspectUi, leaveQueue, openPhoto, openQueue, resetInspect } from './inspectUi';

beforeEach(() => {
  workspace.setState({ project: null });
  resetInspect();
});

describe('Inspect view state', () => {
  it('opens and leaves the queue, and resets on a new project', () => {
    openPhoto({ layerId: 'photos', photoId: 'p1' });
    openQueue('crack');
    expect(inspectUi.getState()).toMatchObject({
      panel: 'queue',
      queueClass: 'crack',
      drawerOpen: true,
    });
    leaveQueue();
    expect(inspectUi.getState()).toMatchObject({ panel: 'photo', queueClass: null });
    expect(inspectUi.getState().photo).toEqual({ layerId: 'photos', photoId: 'p1' });
    openQueue();
    expect(inspectUi.getState().queueClass).toBeNull();
    workspace.setState({ project: { id: 'other' } as never });
    expect(inspectUi.getState()).toMatchObject({ photo: null, panel: 'photo', drawerOpen: false });
  });
});
