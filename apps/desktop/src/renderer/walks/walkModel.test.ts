import { describe, expect, it } from 'vitest';
import { paneOptions, resolveSplit, type SplitPref } from '../workspace/splitModel';
import {
  formatWalkTime,
  importAnswered,
  pickWalk,
  splitWithWalk,
  walkKeyAction,
  walkUnstabilised,
} from './walkModel';

describe('formatWalkTime', () => {
  it('writes minutes and seconds, hours only when there are any', () => {
    expect(formatWalkTime(0)).toBe('0:00');
    expect(formatWalkTime(9.9)).toBe('0:09');
    expect(formatWalkTime(81.9)).toBe('1:21');
    expect(formatWalkTime(600)).toBe('10:00');
    expect(formatWalkTime(3725)).toBe('1:02:05');
  });

  it('reads anything that is not a time as zero', () => {
    expect(formatWalkTime(Number.NaN)).toBe('0:00');
    expect(formatWalkTime(-3)).toBe('0:00');
    expect(formatWalkTime(Infinity)).toBe('0:00');
  });
});

describe('walkKeyAction', () => {
  const paused = { playing: false, rate: 1, fps: 30 };
  const playing = { playing: true, rate: 1, fps: 30 };

  it('Space plays and pauses; K pauses at normal speed', () => {
    expect(walkKeyAction(' ', paused)).toEqual({ play: true, rate: 1 });
    expect(walkKeyAction(' ', playing)).toEqual({ play: false });
    expect(walkKeyAction('k', { ...playing, rate: 4 })).toEqual({ play: false, rate: 1 });
  });

  it('L plays, then doubles the speed up to 8 times', () => {
    expect(walkKeyAction('L', paused)).toEqual({ play: true, rate: 1 });
    expect(walkKeyAction('l', playing)).toEqual({ rate: 2 });
    expect(walkKeyAction('l', { ...playing, rate: 8 })).toEqual({ rate: 8 });
  });

  it('J slows a fast playback, else pauses and steps back a second', () => {
    expect(walkKeyAction('j', { ...playing, rate: 4 })).toEqual({ rate: 2 });
    expect(walkKeyAction('j', playing)).toEqual({ play: false, seekBy: -1 });
    expect(walkKeyAction('j', paused)).toEqual({ play: false, seekBy: -1 });
  });

  it('comma, period and the arrow keys step one frame', () => {
    expect(walkKeyAction(',', playing)).toEqual({ play: false, seekBy: -1 / 30 });
    expect(walkKeyAction('ArrowLeft', paused)).toEqual({ play: false, seekBy: -1 / 30 });
    expect(walkKeyAction('.', paused)).toEqual({ play: false, seekBy: 1 / 30 });
    expect(walkKeyAction('ArrowRight', { ...paused, fps: 0 })).toEqual({
      play: false,
      seekBy: 1 / 30,
    });
  });

  it('leaves every other key alone', () => {
    expect(walkKeyAction('a', paused)).toBeNull();
    expect(walkKeyAction('Enter', paused)).toBeNull();
  });
});

describe('importAnswered', () => {
  it('is the moment main answers an import, not the moment the panel is free again', () => {
    // main was importing and has answered: the walk list is asked for again now, even though
    // the import is still busy with a drawing's page question
    expect(importAnswered({ cancellable: true }, { cancellable: false })).toBe(true);
    expect(importAnswered({ cancellable: false }, { cancellable: false })).toBe(false);
    expect(importAnswered({ cancellable: false }, { cancellable: true })).toBe(false);
    expect(importAnswered({ cancellable: true }, { cancellable: true })).toBe(false);
  });
});

describe('pickWalk', () => {
  const walks = [{ id: 'b' }, { id: 'a' }];
  it('keeps the chosen walk while the project has it, else takes the first', () => {
    expect(pickWalk(walks, 'a')?.id).toBe('a');
    expect(pickWalk(walks, 'gone')?.id).toBe('b');
    expect(pickWalk(walks, null)?.id).toBe('b');
    expect(pickWalk<{ id: string }>([], 'a')).toBeUndefined();
  });
});

describe('splitWithWalk', () => {
  const options = paneOptions([], 0, 0, { walks: 1 });

  it('puts the 360 video on the right of the default split', () => {
    const next = splitWithWalk(undefined, options);
    expect(next).toMatchObject({ left: '3d', right: 'walk360' });
  });

  it('leaves a split alone that already shows it', () => {
    const saved: SplitPref = { left: 'walk360', right: 'map' };
    expect(splitWithWalk(saved, options)).toMatchObject({ left: 'walk360', right: 'map' });
  });

  it('keeps the left side the person chose', () => {
    const saved: SplitPref = { left: 'map', right: '3d' };
    expect(splitWithWalk(saved, options)).toMatchObject({ left: 'map', right: 'walk360' });
  });
});

describe('the split and walks', () => {
  it('offers the 360 video pane only when the project has a walk', () => {
    expect(paneOptions([], 0)).not.toContain('walk360');
    expect(paneOptions([], 0, 0, { walks: 0 })).not.toContain('walk360');
    expect(paneOptions([], 0, 0, { walks: 2 })).toContain('walk360');
  });

  it('falls back to the default when a remembered 360 video pane has nothing to show', () => {
    const saved: SplitPref = { left: '3d', right: 'walk360' };
    expect(resolveSplit(saved, paneOptions([], 0))).toMatchObject({ left: '3d', right: 'map' });
    expect(resolveSplit(saved, paneOptions([], 0, 0, { walks: 1 }))).toMatchObject({
      left: '3d',
      right: 'walk360',
    });
  });
});

describe('walkUnstabilised', () => {
  it('is true for a walk stitched from a camera file, false for a stitched MP4', () => {
    expect(walkUnstabilised({ source: { layout: 'insv-dual-stream' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'dual-fisheye' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'equirect' } })).toBe(false);
  });
});
