// @vitest-environment jsdom
import { emptyCleanup } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { cleanupSummary, exportCleanupFor } from './ExportDialog';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: true, value: [] }) },
  useShell: () => null,
}));

describe('the Apply cleanup line', () => {
  it('says what goes', () => {
    expect(
      cleanupSummary({
        ...emptyCleanup('a'),
        clipBox: { center: [0, 0, 0], size: [1, 1, 1], yaw: 0, keep: 'inside' },
        hiddenClasses: [7, 18],
        regions: [
          {
            id: 'r',
            shape: 'box',
            viewProj: new Array<number>(16).fill(0),
            polygon: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            action: { kind: 'delete' },
          },
        ],
      }),
    ).toBe(
      'Removes points outside the clip box, 1 deleted selection, and the hidden classes (7, 18).',
    );
    expect(cleanupSummary({ ...emptyCleanup('a'), regions: [] })).toBe(
      'Nothing is removed: the cleanup only hides points in the view.',
    );
  });
});

describe('when Apply cleanup is offered', () => {
  const changing = { ...emptyCleanup('a'), hiddenClasses: [7] };

  it('is hidden for a cloud without a recipe', () => {
    expect(exportCleanupFor('a', {})).toBeNull();
    expect(exportCleanupFor(undefined, { a: changing })).toBeNull();
  });

  it('is hidden for a png-packed layer, which never has a recipe', () => {
    expect(exportCleanupFor('packed', { a: changing })).toBeNull();
  });

  it('is hidden for a recipe with nothing to remove', () => {
    expect(exportCleanupFor('a', { a: emptyCleanup('a') })).toBeNull();
  });

  it('gives the recipe when it changes something', () => {
    expect(exportCleanupFor('a', { a: changing })).toBe(changing);
  });
});
