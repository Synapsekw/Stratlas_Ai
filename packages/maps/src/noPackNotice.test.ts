import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimNoPackNotice,
  dismissNoPackNotice,
  resetNoPackNotice,
  showsNoPackNotice,
  subscribeNoPackNotice,
} from './noPackNotice';

describe('the no map pack note', () => {
  beforeEach(() => {
    resetNoPackNotice();
  });

  it('shows on one map at a time', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const leaveA = claimNoPackNotice(a);
    claimNoPackNotice(b);
    expect(showsNoPackNotice(a)).toBe(true);
    expect(showsNoPackNotice(b)).toBe(false);
    // the first map goes: the other one takes the note
    leaveA();
    expect(showsNoPackNotice(b)).toBe(true);
  });

  it('shows on the main map before a compared one', () => {
    const compared = Symbol('compared');
    const main = Symbol('main');
    claimNoPackNotice(compared, false);
    const leaveMain = claimNoPackNotice(main, true);
    expect(showsNoPackNotice(main)).toBe(true);
    expect(showsNoPackNotice(compared)).toBe(false);
    leaveMain();
    expect(showsNoPackNotice(compared)).toBe(true);
  });

  it('notice shows once per session', () => {
    const a = Symbol('a');
    const leave = claimNoPackNotice(a);
    const heard = vi.fn();
    subscribeNoPackNotice(heard);
    dismissNoPackNotice();
    expect(heard).toHaveBeenCalled();
    expect(showsNoPackNotice(a)).toBe(false);
    // a map opened later (another project, Split) does not bring it back
    leave();
    const b = Symbol('b');
    claimNoPackNotice(b);
    expect(showsNoPackNotice(b)).toBe(false);
  });
});
