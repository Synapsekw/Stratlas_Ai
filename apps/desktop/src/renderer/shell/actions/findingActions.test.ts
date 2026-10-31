// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const place = vi.hoisted(() => vi.fn());
vi.mock('../../placement', () => ({ offerPlacement: place }));

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
    expect(items('plain').some((i) => i.id === 'issue.placeOnModel')).toBe(true);
  });

  it('Move point starts a session and Place on model makes the offer', () => {
    const tg = one('pc');
    const ctx = makeActionCtx({ manifest });
    const list = actionsFor(tg, ctx);
    list.find((i) => i.id === 'finding.movePoint')?.run();
    expect(moveSession.getState().issueId).toBe('pc');
    list.find((i) => i.id === 'issue.placeOnModel')?.run();
    expect(place).toHaveBeenCalledWith(['pc'], 'menu');
  });
});
