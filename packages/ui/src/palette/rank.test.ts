import { describe, expect, it } from 'vitest';
import { rankCommands, scoreMatch, type Command } from './rank';

const cmd = (id: string, title: string, group = 'Actions', keywords?: string[]): Command => ({
  id,
  title,
  group,
  ...(keywords ? { keywords } : {}),
  run: () => undefined,
});

describe('scoreMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(scoreMatch('dj789', 'DJI_0789 tanks pass')).not.toBeNull();
    expect(scoreMatch('xyz', 'DJI_0789')).toBeNull();
  });
  it('prefers prefixes and word starts over scattered letters', () => {
    const prefix = scoreMatch('set', 'Settings') ?? 0;
    const word = scoreMatch('set', 'Open settings') ?? 0;
    const scattered = scoreMatch('set', 'Show selected text') ?? 0;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(scattered);
  });
});

describe('rankCommands', () => {
  const list = [
    cmd('a', 'Go to Projects', 'Navigate'),
    cmd('b', 'Toggle sidebar'),
    cmd('c', 'F01 Crack in bottom plate', 'Issues', ['crack', 'critical']),
    cmd('d', 'Settings', 'Navigate'),
  ];

  it('keeps the original order for an empty query', () => {
    expect(rankCommands(list, '').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('filters and ranks by score', () => {
    expect(rankCommands(list, 'set').map((c) => c.id)).toEqual(['d']);
    expect(rankCommands(list, 'f01').map((c) => c.id)).toEqual(['c']);
  });
  it('searches keywords too', () => {
    expect(rankCommands(list, 'critical').map((c) => c.id)).toEqual(['c']);
  });
  it('limits the result', () => {
    expect(rankCommands(list, '', 2)).toHaveLength(2);
  });
});
