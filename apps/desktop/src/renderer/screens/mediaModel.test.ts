import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { flightCards, flightOf } from './mediaModel';

const T0 = Date.UTC(2023, 10, 22, 5, 0, 0);

const clip = (
  id: string,
  flight: string,
  start: number,
  offsetMs: number,
  poster = true,
): Layer => ({
  kind: 'video',
  id,
  name: `${flight} · clip ${id}`,
  visible: true,
  src: { path: `video/${id}.mp4` },
  flight: { src: { path: `flights/${flight}.json` }, startUtcMs: start },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs,
  ...(poster ? { poster: { path: `posters/${id}.jpg` } } : {}),
});

describe('media flight cards', () => {
  const layers: Layer[] = [
    clip('b1', 'Flight 102', T0 + 600_000, 0),
    clip('a2', 'Flight 101', T0, 60_000),
    clip('a1', 'Flight 101', T0, 0, false),
  ];

  it('groups clips by flight, in time order, with the span and a poster', () => {
    const cards = flightCards(layers, { a1: 60_000, a2: 45_000, b1: 30_000 });
    expect(cards.map((c) => c.name)).toEqual(['Flight 101 · clip a', 'Flight 102 · clip b1']);
    const [f101] = cards;
    expect(f101?.clips.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(f101?.startMs).toBe(T0);
    expect(f101?.endMs).toBe(T0 + 105_000);
    expect(f101?.estimated).toBe(false);
    expect(f101?.poster).toEqual({ path: 'posters/a2.jpg' });
  });

  it('marks spans that still use the default clip length', () => {
    const [f101] = flightCards(layers, { a1: 60_000 });
    expect(f101?.estimated).toBe(true);
    expect(f101?.endMs).toBe(T0 + 120_000);
  });

  it('finds the flight of the active clip, else the first', () => {
    const cards = flightCards(layers, {});
    expect(flightOf(cards, 'b1')?.clips[0]?.id).toBe('b1');
    expect(flightOf(cards, null)?.clips[0]?.id).toBe('a1');
    expect(flightOf([], 'b1')).toBeNull();
  });
});
