import { describe, expect, it } from 'vitest';
import {
  islandGroups,
  islandReducer,
  islandRest,
  pickLive,
  type GroupId,
  type IslandState,
  type LiveItem,
} from './islandModel';

const job = (id: string): LiveItem => ({ kind: 'job', id, label: id, progress: 0.5, more: 0 });
const tool: LiveItem = { kind: 'tool', label: 'Distance', reading: '4.2 m' };
const flags = {
  map: true,
  mode: 'map' as const,
  clouds: true,
  volumes: true,
  video: true,
  road: true,
  pkg: false,
};

describe('islandRest', () => {
  it('maps survey date counts', () => {
    expect(islandRest(0)).toBe('dots');
    expect(islandRest(1)).toBe('date');
    expect(islandRest(2)).toBe('dateSteps');
  });
});

describe('pickLive', () => {
  it('puts the tool first and the newest job second with a count', () => {
    const r = pickLive([job('a'), tool, job('b')]);
    expect(r.primary?.kind).toBe('tool');
    expect(r.secondary).toMatchObject({ kind: 'job', id: 'b', more: 1 });
  });
  it('ranks playback above jobs and connection last', () => {
    const playback: LiveItem = { kind: 'playback', clip: 'c', progress: 0.1, telemetry: null };
    const conn: LiveItem = { kind: 'connection', state: 'back' };
    const r = pickLive([conn, job('a'), playback]);
    expect(r.primary?.kind).toBe('playback');
    expect(r.secondary?.kind).toBe('job');
    expect(pickLive([conn]).primary).toBe(conn);
  });
  it('shows connection alone as primary and handles empty', () => {
    const c: LiveItem = { kind: 'connection', state: 'offline' };
    expect(pickLive([c])).toEqual({ primary: c, secondary: null });
    expect(pickLive([])).toEqual({ primary: null, secondary: null });
  });
  it('counts all jobs in more', () => {
    expect(pickLive([job('a'), job('b'), job('c')]).primary).toMatchObject({ id: 'c', more: 2 });
  });
});

describe('islandGroups', () => {
  it('excludes annotate for packages and road in 3d', () => {
    expect(islandGroups({ ...flags, pkg: true })).not.toContain('annotate');
    expect(islandGroups({ ...flags, mode: '3d' })).not.toContain('road');
    expect(islandGroups({ ...flags, mode: 'split' })).toContain('road');
  });
  it('hides point clouds and volumes in the map view', () => {
    const g = islandGroups({ ...flags, map: true });
    expect(g).not.toContain('clouds');
    expect(g).not.toContain('volumes');
    expect(islandGroups({ ...flags, map: false, mode: '3d' })).toContain('clouds');
  });
  it('keeps the fixed order and hides groups without data', () => {
    const all: GroupId[] = [
      'view',
      'measure',
      'display',
      'clouds',
      'volumes',
      'video',
      'road',
      'annotate',
    ];
    expect(islandGroups({ ...flags, map: false })).toEqual(all);
    expect(
      islandGroups({ ...flags, clouds: false, volumes: false, video: false, road: false }),
    ).toEqual(['view', 'measure', 'display', 'annotate']);
  });
});

describe('islandReducer', () => {
  const rest: IslandState = { open: 'rest', group: 'view', preview: null, swapped: false };
  it('toggles tools and escapes', () => {
    const t = islandReducer(rest, { type: 'toggleTools' });
    expect(t.open).toBe('tools');
    expect(islandReducer(t, { type: 'escape' }).open).toBe('rest');
    expect(islandReducer(t, { type: 'toggleTools' }).open).toBe('rest');
  });
  it('previews on hover and commits on pick', () => {
    const h = islandReducer({ ...rest, open: 'tools' }, { type: 'hoverGroup', group: 'display' });
    expect(h).toMatchObject({ preview: 'display', group: 'view' });
    expect(islandReducer(h, { type: 'pickGroup', group: 'display' })).toMatchObject({
      group: 'display',
      preview: null,
      open: 'rest',
    });
  });
  it('leave closes ready but not tools', () => {
    const near = islandReducer(rest, { type: 'near' });
    expect(near.open).toBe('ready');
    expect(islandReducer(near, { type: 'leave' }).open).toBe('rest');
    const tools = { ...rest, open: 'tools' as const };
    expect(islandReducer(tools, { type: 'leave' }).open).toBe('tools');
  });
  it('swaps back and clears the swap when the live pair changes', () => {
    const sw = islandReducer(rest, { type: 'swap' });
    expect(islandReducer(sw, { type: 'swap' }).swapped).toBe(false);
    expect(islandReducer(sw, { type: 'liveChanged' }).swapped).toBe(false);
    expect(islandReducer(sw, { type: 'pickGroup', group: 'view' }).swapped).toBe(true);
  });
  it('clears the preview on leave and escape, and escapes the date', () => {
    const hov = { ...rest, open: 'ready' as const, preview: 'display' as const };
    expect(islandReducer(hov, { type: 'leave' }).preview).toBeNull();
    expect(islandReducer({ ...hov, open: 'tools' }, { type: 'escape' })).toMatchObject({
      open: 'rest',
      preview: null,
    });
    const date = islandReducer(rest, { type: 'openDate' });
    expect(islandReducer(date, { type: 'leave' }).open).toBe('date');
    expect(islandReducer(date, { type: 'escape' }).open).toBe('rest');
    expect(islandReducer({ ...rest, open: 'tools' }, { type: 'near' }).open).toBe('tools');
  });
  it('opens the date and swaps', () => {
    expect(islandReducer(rest, { type: 'openDate' }).open).toBe('date');
    expect(islandReducer(rest, { type: 'swap' }).swapped).toBe(true);
  });
});
