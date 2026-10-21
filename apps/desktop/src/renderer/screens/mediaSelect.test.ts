import type { PhotoPick } from '@aio/ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { clickPicks, mediaPicks, menuPicks, tileTarget } from './mediaSelect';

const p = (photoId: string, layerId = 'photos'): PhotoPick => ({ layerId, photoId });
const order = [p('a'), p('b'), p('c'), p('d'), p('e', 'other')];
const none = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };

describe('clickPicks', () => {
  it('a plain click picks that tile only', () => {
    const s = clickPicks({ picks: [p('a'), p('b')], anchor: p('a') }, p('c'), none, order);
    expect(s).toEqual({ picks: [p('c')], anchor: p('c') });
  });

  it('Ctrl toggles a tile in and out of the picks', () => {
    const one = clickPicks({ picks: [p('a')], anchor: p('a') }, p('c'), ctrl, order);
    expect(one.picks).toEqual([p('a'), p('c')]);
    expect(one.anchor).toEqual(p('c'));
    const back = clickPicks(one, p('a'), ctrl, order);
    expect(back.picks).toEqual([p('c')]);
  });

  it('Shift adds the range from the anchor in tile order, keeping earlier picks', () => {
    const s = clickPicks({ picks: [p('a')], anchor: p('b') }, p('d'), shift, order);
    expect(s.picks).toEqual([p('a'), p('b'), p('c'), p('d')]);
    // the anchor stays where the range started, so a second Shift click redraws from there
    expect(s.anchor).toEqual(p('b'));
  });

  it('Shift works backwards and across photo sets', () => {
    const s = clickPicks({ picks: [], anchor: p('e', 'other') }, p('c'), shift, order);
    expect(s.picks).toEqual([p('e', 'other'), p('d'), p('c')]);
  });

  it('Shift without an anchor (or one not shown) adds just the tile', () => {
    expect(clickPicks({ picks: [], anchor: null }, p('b'), shift, order)).toEqual({
      picks: [p('b')],
      anchor: p('b'),
    });
    expect(clickPicks({ picks: [], anchor: p('zz') }, p('b'), shift, order).picks).toEqual([
      p('b'),
    ]);
  });
});

describe('menuPicks', () => {
  it('a right-click on a picked tile acts on every pick', () => {
    expect(menuPicks([p('a'), p('c')], p('c'))).toEqual({ picks: [p('a'), p('c')], reset: false });
  });

  it('a right-click on another tile acts on that tile only and resets the picks to it', () => {
    expect(menuPicks([p('a'), p('c')], p('b'))).toEqual({ picks: [p('b')], reset: true });
    expect(menuPicks([], p('b'))).toEqual({ picks: [p('b')], reset: true });
  });
});

describe('tileTarget', () => {
  it('a photo tile among the picks targets every pick', () => {
    const k = { kind: 'photo' as const, layerId: 'photos', itemId: 'c' };
    expect(tileTarget(k, [p('a'), p('c')])).toEqual({ kind: 'photos', picks: [p('a'), p('c')] });
  });

  it('a photo tile not picked targets itself only', () => {
    const k = { kind: 'photo' as const, layerId: 'photos', itemId: 'b' };
    expect(tileTarget(k, [p('a'), p('c')])).toEqual({ kind: 'photos', picks: [p('b')] });
    expect(tileTarget(k)).toEqual({ kind: 'photos', picks: [p('b')] });
  });

  it('a 360 tile stays a media target of itself', () => {
    const k = { kind: 'pano' as const, layerId: 'panos', itemId: 's1' };
    expect(tileTarget(k, [p('a')])).toEqual({ kind: 'media', picks: [k] });
  });
});

describe('mediaPicks store', () => {
  beforeEach(() => {
    mediaPicks.getState().clear();
  });

  it('clicks, resets and clears, and drops picks of another project', () => {
    const s = mediaPicks.getState();
    s.click('p1', p('a'), none, order);
    s.click('p1', p('c'), ctrl, order);
    expect(mediaPicks.getState().picks).toEqual([p('a'), p('c')]);
    mediaPicks.getState().reset('p1', [p('b')]);
    expect(mediaPicks.getState().picks).toEqual([p('b')]);
    // a click in another project starts afresh: picks never cross projects
    mediaPicks.getState().click('p2', p('d'), ctrl, order);
    expect(mediaPicks.getState()).toMatchObject({ projectId: 'p2', picks: [p('d')] });
    mediaPicks.getState().clear();
    expect(mediaPicks.getState().picks).toEqual([]);
  });
});
