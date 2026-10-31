import { describe, expect, it } from 'vitest';
import { splitShowsMap } from './splitMap';

const photos = [{ kind: 'photos' as const }];

describe('splitShowsMap', () => {
  it('the default split shows the map', () => {
    expect(splitShowsMap(undefined, [])).toBe(true);
    expect(splitShowsMap(undefined, photos)).toBe(true);
  });

  it('a saved photo beside 3D does not, while the photo layer is there', () => {
    expect(splitShowsMap({ left: '3d', right: 'photo' }, photos)).toBe(false);
  });

  it('a saved pane whose layer is gone falls back to the map', () => {
    expect(splitShowsMap({ left: '3d', right: 'photo' }, [])).toBe(true);
  });

  it('a split with a map pane shows it, and a comparison of two dates does not', () => {
    expect(splitShowsMap({ left: 'map', right: 'photo' }, photos)).toBe(true);
    expect(
      splitShowsMap({ left: '3d', right: '3d', leftCapture: 'c1', rightCapture: 'c2' }, []),
    ).toBe(false);
  });
});
