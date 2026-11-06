// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createLayoutPrefs, layoutKey, parseOverrides } from './layoutStore';

const memory = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe('layoutPrefs', () => {
  it('reads only what it knows from quadrion.layout.<projectId>', () => {
    expect(parseOverrides('{"rightTab":"tools","strip":"footage","stage":"map","x":1}')).toEqual({
      rightTab: 'tools',
      strip: 'footage',
      stage: 'map',
    });
    expect(
      parseOverrides('{"rightTab":"nope","islandMode":"road","layersOpenWide":false}'),
    ).toEqual({ islandMode: 'road', layersOpenWide: false });
    expect(parseOverrides('not json')).toEqual({});
    expect(parseOverrides(null)).toEqual({});
  });

  it('a choice is remembered per project, and Reset forgets it', () => {
    const s = memory();
    const prefs = createLayoutPrefs(s);
    prefs.getState().choose('p1', { rightTab: 'tools' });
    prefs.getState().choose('p1', { stage: 'map' });
    expect(JSON.parse(s.m.get(layoutKey('p1')) ?? '{}')).toEqual({
      rightTab: 'tools',
      stage: 'map',
    });
    // another session reads it back
    expect(createLayoutPrefs(s).getState().get('p1')).toEqual({ rightTab: 'tools', stage: 'map' });
    expect(prefs.getState().get('p2')).toEqual({});
    const seq = prefs.getState().resetSeq;
    prefs.getState().reset('p1');
    expect(s.m.has(layoutKey('p1'))).toBe(false);
    expect(prefs.getState().get('p1')).toEqual({});
    expect(prefs.getState().resetSeq).toBe(seq + 1);
  });

  it('blocked storage: the choice lasts for the session', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const prefs = createLayoutPrefs(broken);
    prefs.getState().choose('p', { strip: 'dates' });
    expect(prefs.getState().get('p')).toEqual({ strip: 'dates' });
  });
});
