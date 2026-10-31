// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const place = vi.hoisted(() => vi.fn());
const go = vi.hoisted(() => vi.fn());
const space = vi.hoisted(() => vi.fn());
const stageMode = vi.hoisted(() => ({ mode: '3d', set: vi.fn() }));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../../placement', () => ({ offerPlacement: place }));
vi.mock('../../shell', () => ({
  shell: { getState: () => ({ go, stageMode: stageMode.mode, setStageMode: stageMode.set }) },
}));
vi.mock('../../flyability/flag', () => ({ isInspectorUiOn: () => flag.on }));
vi.mock('../../spaces/activeSpace', () => ({ setActiveSpace: space }));

const { registerFindingActions } = await import('./findingActions');
const { moveSession, cancelMovePoint } = await import('../../flyability/movePoint');

const manifest = {
  captures: [],
  layers: [],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;

const NOW = '2026-10-01T00:00:00.000Z';
const issue = (id: string, extra: Partial<Issue>): Issue =>
  ({
    id,
    code: id.toUpperCase(),
    classId: 'c',
    severityModelId: 'm',
    severity: 1,
    status: 'draft',
    title: id,
    note: '',
    author: 'a',
    createdAt: NOW,
    updatedAt: NOW,
    source: 'manual',
    sightings: [],
    ...extra,
  }) as Issue;

const cloud = issue('pc', {
  sightings: [{ on: 'pointcloud', layer: 'l', geom: { type: 'point3', p: [0, 0, 0] } }],
});
const plain = issue('plain', {});
const imported = issue('imp', {
  external: {
    source: 'flyability',
    poi: 'p',
    snapshots: ['s'],
    wallDistanceM: null,
    hitDistanceM: null,
    locationCheck: 'unchecked',
  },
});

const one = (id: string): MenuTarget => ({ kind: 'issues', ids: [id], clicked: id });
const items = (id: string, canEdit = true) =>
  actionsFor(one(id), makeActionCtx({ manifest, canEdit }));

let off: () => void;
beforeEach(() => {
  flag.on = true;
  stageMode.mode = '3d';
  stageMode.set.mockReset();
  off = registerFindingActions();
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest }, [cloud, plain, imported]);
});
afterEach(() => {
  off();
  cancelMovePoint();
});

describe('finding actions', () => {
  it('Move point is offered on a finding and greyed in a read-only project', () => {
    const item = items('pc').find((i) => i.id === 'finding.movePoint');
    expect(item).toBeDefined();
    expect(item?.disabled).toBe(false);
    expect(items('imp').some((i) => i.id === 'finding.movePoint')).toBe(true);
    const ro = items('pc', false).find((i) => i.id === 'finding.movePoint');
    expect(ro?.disabled).toBeTruthy();
  });

  it('Move point is not offered on an issue without a cloud point or import', () => {
    expect(items('plain').some((i) => i.id === 'finding.movePoint')).toBe(false);
    const placeItem = items('plain').find((i) => i.id === 'issue.placeOnModel');
    expect(placeItem?.testId).toBe('issue-place-on-model');
  });

  it('Move point starts a session and Place on model makes the offer', () => {
    const tg = one('pc');
    const ctx = makeActionCtx({ manifest });
    const list = actionsFor(tg, ctx);
    list.find((i) => i.id === 'finding.movePoint')?.run();
    expect(moveSession.getState().issueId).toBe('pc');
    expect(go).toHaveBeenCalledWith('scene');
    expect(space).toHaveBeenCalledWith('p1', 'main');
    list.find((i) => i.id === 'issue.placeOnModel')?.run();
    expect(place).toHaveBeenCalledWith(['pc'], 'menu');
  });

  it('with the inspector UI off, Move point is offered only on an imported finding', () => {
    flag.on = false;
    expect(items('pc').some((i) => i.id === 'finding.movePoint')).toBe(false);
    expect(items('imp').some((i) => i.id === 'finding.movePoint')).toBe(true);
  });

  it('Move point from the map view switches the stage to 3D', () => {
    stageMode.mode = 'map';
    items('pc')
      .find((i) => i.id === 'finding.movePoint')
      ?.run();
    expect(stageMode.set).toHaveBeenCalledWith('3d');
  });

  it('Move point from the 3D view leaves the stage mode alone', () => {
    items('pc')
      .find((i) => i.id === 'finding.movePoint')
      ?.run();
    expect(stageMode.set).not.toHaveBeenCalled();
  });
});
