import { describe, expect, it } from 'vitest';
import { reviewCommand, type KeyLike } from './keys';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('review keys', () => {
  it('steps through detections and photos', () => {
    expect(reviewCommand(key('j'))).toEqual({ kind: 'next' });
    expect(reviewCommand(key('ArrowLeft'))).toEqual({ kind: 'prev' });
    expect(reviewCommand(key('J', { shiftKey: true }))).toEqual({ kind: 'nextSource' });
    expect(reviewCommand(key('PageUp'))).toEqual({ kind: 'prevSource' });
  });

  it('decides with one key', () => {
    expect(reviewCommand(key('a'))).toEqual({ kind: 'accept' });
    expect(reviewCommand(key('Enter'))).toEqual({ kind: 'accept' });
    expect(reviewCommand(key('x'))).toEqual({ kind: 'reject' });
    expect(reviewCommand(key('l'))).toEqual({ kind: 'link' });
    expect(reviewCommand(key('R', { shiftKey: true }))).toEqual({ kind: 'reopen' });
    expect(reviewCommand(key('u'))).toEqual({ kind: 'uncertain' });
    expect(reviewCommand(key('3'))).toEqual({ kind: 'severity', value: 3 });
    expect(reviewCommand(key('C', { shiftKey: true }))).toEqual({ kind: 'class', step: -1 });
  });

  it('switches tools and undoes', () => {
    expect(reviewCommand(key('b'))).toEqual({ kind: 'tool', tool: 'box' });
    expect(reviewCommand(key('z', { ctrlKey: true }))).toEqual({ kind: 'undo' });
    expect(reviewCommand(key('Z', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'redo' });
    expect(reviewCommand(key('y', { metaKey: true }))).toEqual({ kind: 'redo' });
    expect(reviewCommand(key('a', { altKey: true }))).toBeNull();
    expect(reviewCommand(key('q'))).toBeNull();
  });
});
