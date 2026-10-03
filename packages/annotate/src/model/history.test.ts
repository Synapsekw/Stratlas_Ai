import { describe, expect, it } from 'vitest';
import { makeIssue } from '../testing';
import { History, applyChange, invert, type Change } from './history';

const a = makeIssue({ id: 'a' });
const a2 = makeIssue({ id: 'a', title: 'Edited' });
const b = makeIssue({ id: 'b', code: 'F02' });

const edit: Change = { label: 'Edit', before: { a }, after: { a: a2 } };
const create: Change = { label: 'Create', before: { b: null }, after: { b } };

describe('applyChange', () => {
  it('upserts and removes issues, keeping order', () => {
    expect(applyChange([a], edit)).toEqual([a2]);
    expect(applyChange([a], create)).toEqual([a, b]);
    expect(applyChange([a, b], invert(create))).toEqual([a]);
  });
});

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History();
    h.push(create);
    h.push(edit);
    expect(h.canUndo).toBe(true);
    expect(h.undo()?.label).toBe('Edit');
    expect(h.undo()?.after).toEqual({ b: null });
    expect(h.undo()).toBeNull();
    expect(h.redo()?.label).toBe('Create');
    expect(h.canRedo).toBe(true);
  });

  it('returns inverted changes on undo', () => {
    const h = new History();
    h.push(edit);
    expect(h.undo()).toEqual({ label: 'Edit', before: { a: a2 }, after: { a } });
  });

  it('drops the redo branch on a new change', () => {
    const h = new History();
    h.push(create);
    h.undo();
    h.push(edit);
    expect(h.canRedo).toBe(false);
  });

  it('keeps at most `limit` steps', () => {
    const h = new History(2);
    h.push(create);
    h.push(edit);
    h.push(edit);
    h.undo();
    h.undo();
    expect(h.canUndo).toBe(false);
  });

  it('labels the next undo and redo', () => {
    const h = new History();
    h.push(create);
    expect(h.undoLabel).toBe('Create');
    h.undo();
    expect(h.redoLabel).toBe('Create');
    h.clear();
    expect(h.canRedo).toBe(false);
  });
});
