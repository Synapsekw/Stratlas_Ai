import { emptyCleanup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createCleanupRecipes } from './store';

describe('the live recipes', () => {
  it('sets, replaces and removes a layer recipe, a new object each time', () => {
    const s = createCleanupRecipes();
    const before = s.getState().recipes;
    s.getState().set('a', emptyCleanup('a'));
    expect(s.getState().recipes.a?.layerId).toBe('a');
    expect(s.getState().recipes).not.toBe(before);
    s.getState().set('a', null);
    expect(s.getState().recipes.a).toBeUndefined();
    s.getState().set('b', emptyCleanup('b'));
    s.getState().clear();
    expect(s.getState().recipes).toEqual({});
  });
});
