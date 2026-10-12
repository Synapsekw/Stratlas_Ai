import type { WalkLayer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { walkBadge, walkGroupAction } from './walkBadge';

const bare: WalkLayer = {
  kind: 'walk',
  id: 'walk-a',
  name: 'A',
  visible: true,
  record: { path: 'walks/a/walk.json' },
  src: { path: 'walks/a/playback.mp4' },
  durationS: 81.9,
};
const path = { raw: { path: 'walks/a/raw-path.json' } };
const placed = (quality: 'good' | 'check' | 'poor' | 'unplaced'): WalkLayer => ({
  ...bare,
  path,
  place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality },
});

describe('walkBadge', () => {
  it('says Files missing before anything else', () => {
    expect(walkBadge(bare, true)).toEqual({ text: 'Files missing', tone: 'warn' });
    expect(walkBadge(placed('good'), true)).toEqual({ text: 'Files missing', tone: 'warn' });
  });

  it('says Needs placing for a walk with no placement, path or not', () => {
    expect(walkBadge(bare, false)).toEqual({ text: 'Needs placing', tone: 'info' });
    expect(walkBadge({ ...bare, path }, false)).toEqual({ text: 'Needs placing', tone: 'info' });
    expect(walkBadge(placed('unplaced'), false)).toEqual({ text: 'Needs placing', tone: 'info' });
  });

  it('says Path not computed for a placed walk with no path', () => {
    const noPath: WalkLayer = {
      ...bare,
      place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'poor' },
    };
    expect(walkBadge(noPath, false)).toEqual({ text: 'Path not computed', tone: 'info' });
  });

  it('says Check placing for a check or poor fit, nothing for a good one', () => {
    expect(walkBadge(placed('check'), false)).toEqual({ text: 'Check placing', tone: 'warn' });
    expect(walkBadge(placed('poor'), false)).toEqual({ text: 'Check placing', tone: 'warn' });
    expect(walkBadge(placed('good'), false)).toBeNull();
  });
});

describe('walkGroupAction', () => {
  const onAdd = () => undefined;
  it('puts Add 360 video on the 360 walks header of a project', () => {
    expect(walkGroupAction('walks', false, 'Add 360 video', onAdd)).toEqual({
      label: 'Add 360 video',
      onClick: onAdd,
    });
  });
  it('adds nothing in a package or on another header', () => {
    expect(walkGroupAction('walks', true, 'Add 360 video', onAdd)).toBeUndefined();
    expect(walkGroupAction('video', false, 'Add 360 video', onAdd)).toBeUndefined();
  });
});
