import { describe, expect, it } from 'vitest';
import {
  islandGroups,
  islandInitial,
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
  const rest: IslandState = islandInitial(false);
  const pinned: IslandState = islandInitial(true);
  it('starts at rest, or open when it was left pinned', () => {
    expect(rest).toMatchObject({ open: 'rest', pinned: false });
    expect(pinned).toMatchObject({ open: 'tools', pinned: true });
  });
  it('toggles tools and escapes', () => {
    const t = islandReducer(rest, { type: 'toggleTools' });
    expect(t.open).toBe('tools');
    expect(islandReducer(t, { type: 'escape' }).open).toBe('rest');
    expect(islandReducer(t, { type: 'toggleTools' }).open).toBe('rest');
  });
  it('previews on hover and commits on pick, the tools still open', () => {
    const h = islandReducer({ ...rest, open: 'tools' }, { type: 'hoverGroup', group: 'display' });
    expect(h).toMatchObject({ preview: 'display', group: 'view' });
    expect(islandReducer(h, { type: 'pickGroup', group: 'display' })).toMatchObject({
      group: 'display',
      preview: null,
      open: 'tools',
    });
  });
  it('has no pointer events: it opens and closes on a click, a key or a press outside only', () => {
    // the calendar stays until a date is picked or it is escaped
    const date = islandReducer(rest, { type: 'openDate' });
    expect(islandReducer(date, { type: 'toggleTools' }).open).toBe('tools');
    expect(islandReducer(date, { type: 'escape' }).open).toBe('rest');
  });
  it('pinned, stays open through Esc and T; Esc leaves the calendar for the tools', () => {
    expect(islandReducer(pinned, { type: 'escape' }).open).toBe('tools');
    expect(islandReducer(pinned, { type: 'toggleTools' }).open).toBe('tools');
    const date = islandReducer(pinned, { type: 'openDate' });
    expect(date.open).toBe('date');
    expect(islandReducer(date, { type: 'escape' }).open).toBe('tools');
  });
  it('pins open, unpins without closing, and Close rests and unpins', () => {
    expect(islandReducer(rest, { type: 'pin', on: true })).toMatchObject({
      open: 'tools',
      pinned: true,
    });
    const off = islandReducer(pinned, { type: 'pin', on: false });
    expect(off).toMatchObject({ open: 'tools', pinned: false });
    expect(islandReducer(off, { type: 'escape' }).open).toBe('rest');
    expect(islandReducer(pinned, { type: 'close' })).toMatchObject({ open: 'rest', pinned: false });
  });
  it('swaps back and clears the swap when the live pair changes', () => {
    const sw = islandReducer(rest, { type: 'swap' });
    expect(islandReducer(sw, { type: 'swap' }).swapped).toBe(false);
    expect(islandReducer(sw, { type: 'liveChanged' }).swapped).toBe(false);
    expect(islandReducer(sw, { type: 'pickGroup', group: 'view' }).swapped).toBe(true);
  });
  it('clears the preview on escape, and escapes the date', () => {
    const hov = { ...rest, open: 'tools' as const, preview: 'display' as const };
    expect(islandReducer(hov, { type: 'escape' })).toMatchObject({ open: 'rest', preview: null });
    const date = islandReducer(rest, { type: 'openDate' });
    expect(islandReducer(date, { type: 'escape' }).open).toBe('rest');
  });
  it('opens the date and swaps', () => {
    expect(islandReducer(rest, { type: 'openDate' }).open).toBe('date');
    expect(islandReducer(rest, { type: 'swap' }).swapped).toBe(true);
  });
});
