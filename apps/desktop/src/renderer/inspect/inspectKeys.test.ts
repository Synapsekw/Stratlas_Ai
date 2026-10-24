/**
 * Inspect's keys: the review commands of the shortcut registry, read for the panel in view. In
 * the queue F fixes and Esc leaves; on the photo list F fits and Esc is left to the app; edits go
 * to a draft only when there is one to edit.
 */
import { describe, expect, it } from 'vitest';
import { inspectAction } from './inspectKeys';

describe('inspectAction', () => {
  it('F fixes in the queue and fits outside it; Esc only leaves the queue', () => {
    expect(inspectAction({ kind: 'fix' }, 'queue', true)).toBe('fix');
    expect(inspectAction({ kind: 'fix' }, 'photo', false)).toBe('fit');
    expect(inspectAction({ kind: 'fix' }, 'photo', true)).toBe('fit');
    expect(inspectAction({ kind: 'fit' }, 'queue', true)).toBe('fit');
    expect(inspectAction({ kind: 'leave' }, 'queue', false)).toBe('leave');
    expect(inspectAction({ kind: 'leave' }, 'photo', false)).toBeNull();
  });

  it('passes a severity digit to the current draft only when there is one', () => {
    expect(inspectAction({ kind: 'severity', value: 3 }, 'queue', true)).toEqual({
      edit: { kind: 'severity', value: 3 },
    });
    expect(inspectAction({ kind: 'severity', value: 3 }, 'photo', true)).toEqual({
      edit: { kind: 'severity', value: 3 },
    });
    expect(inspectAction({ kind: 'severity', value: 3 }, 'photo', false)).toBeNull();
    expect(inspectAction({ kind: 'severity', value: 3 }, 'queue', false)).toBeNull();
  });

  it('sends class, uncertain and delete to the current draft as edits', () => {
    for (const cmd of [
      { kind: 'class', step: 1 },
      { kind: 'class', step: -1 },
      { kind: 'uncertain' },
      { kind: 'delete' },
    ] as const) {
      expect(inspectAction(cmd, 'queue', true)).toEqual({ edit: cmd });
      expect(inspectAction(cmd, 'photo', false)).toBeNull();
    }
  });

  it('accepts, dismisses and links in the queue, and on the photo list only a selected draft', () => {
    expect(inspectAction({ kind: 'accept' }, 'queue', true)).toBe('accept');
    expect(inspectAction({ kind: 'reject' }, 'queue', true)).toBe('dismiss');
    expect(inspectAction({ kind: 'link' }, 'queue', true)).toBe('link');
    expect(inspectAction({ kind: 'accept' }, 'photo', true)).toBe('accept');
    expect(inspectAction({ kind: 'reject' }, 'photo', true)).toBe('dismiss');
    expect(inspectAction({ kind: 'link' }, 'photo', true)).toBe('link');
    expect(inspectAction({ kind: 'accept' }, 'photo', false)).toBeNull();
    expect(inspectAction({ kind: 'reject' }, 'photo', false)).toBeNull();
    expect(inspectAction({ kind: 'link' }, 'photo', false)).toBeNull();
  });

  it('steps with J and K, and with Shift between photos or frames', () => {
    expect(inspectAction({ kind: 'next' }, 'photo', false)).toBe('next');
    expect(inspectAction({ kind: 'prev' }, 'queue', true)).toBe('prev');
    expect(inspectAction({ kind: 'nextSource' }, 'queue', true)).toBe('nextSource');
    expect(inspectAction({ kind: 'prevSource' }, 'queue', true)).toBe('prevSource');
    // on the photo list a photo is the step already
    expect(inspectAction({ kind: 'nextSource' }, 'photo', false)).toBe('next');
    expect(inspectAction({ kind: 'prevSource' }, 'photo', false)).toBe('prev');
  });

  it('B draws in both panels; the other tools are left to the viewer', () => {
    expect(inspectAction({ kind: 'tool', tool: 'box' }, 'photo', false)).toBe('draw');
    expect(inspectAction({ kind: 'tool', tool: 'box' }, 'queue', true)).toBe('draw');
    expect(inspectAction({ kind: 'tool', tool: 'polygon' }, 'photo', false)).toBeNull();
    expect(inspectAction({ kind: 'tool', tool: 'select' }, 'photo', false)).toBeNull();
  });

  it('M runs mask assist only on a selected draft, else the viewer toggles its overlay', () => {
    expect(inspectAction({ kind: 'mask' }, 'queue', true)).toBe('mask');
    expect(inspectAction({ kind: 'mask' }, 'photo', true)).toBe('mask');
    expect(inspectAction({ kind: 'mask' }, 'photo', false)).toBeNull();
  });

  it('undoes the review in the queue and leaves Ctrl+Z on the photo list to the findings', () => {
    expect(inspectAction({ kind: 'undo' }, 'queue', true)).toBe('undo');
    expect(inspectAction({ kind: 'redo' }, 'queue', false)).toBe('redo');
    expect(inspectAction({ kind: 'undo' }, 'photo', true)).toBeNull();
    expect(inspectAction({ kind: 'redo' }, 'photo', true)).toBeNull();
  });

  it('has no use for reopen and note', () => {
    expect(inspectAction({ kind: 'reopen' }, 'queue', true)).toBeNull();
    expect(inspectAction({ kind: 'note' }, 'queue', true)).toBeNull();
  });
});
