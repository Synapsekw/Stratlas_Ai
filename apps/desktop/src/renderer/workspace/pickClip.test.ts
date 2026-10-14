import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { pickClip } from './pickClip';

beforeEach(() => {
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
});
afterEach(() => {
  workspace.getState().closeProject();
});
const clip = { startMs: 0, endMs: 60_000 };

describe('pickClip', () => {
  it('selects the clip and seeks to the clicked time without playing', () => {
    pickClip('clip-oct', 12_345, clip);
    const s = workspace.getState();
    expect(s.activeClip).toBe('clip-oct');
    expect(s.selection).toMatchObject({ kind: 'clip', id: 'clip-oct' });
    expect(s.nowMs).toBe(12_345);
    expect(s.playing).toBe(false);
  });
  it('from the keyboard moves the clock to the clip start only when it is outside', () => {
    workspace.getState().setTime(100_000);
    pickClip('clip-oct', undefined, clip);
    expect(workspace.getState().nowMs).toBe(0);
    workspace.getState().setTime(30_000);
    pickClip('clip-oct', undefined, clip);
    expect(workspace.getState().nowMs).toBe(30_000);
    expect(workspace.getState().playing).toBe(false);
  });
});
