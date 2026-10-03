import type { AssetRef, Layer } from '@aio/schema';
import { DEFAULT_CLIP_MS, flightGroups } from '@aio/ui';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

export interface FlightCard {
  id: string;
  name: string;
  clips: VideoLayer[];
  startMs: number;
  endMs: number;
  /** True while a clip length is still the default guess. */
  estimated: boolean;
  /** Poster of the middle clip (mid-flight footage says more than the take-off), else any. */
  poster: AssetRef | undefined;
}

const clipStart = (c: VideoLayer) => c.flight.startUtcMs + c.offsetMs;

/**
 * One card per flight (clips cut from the same flight log), in time order, with the span from the
 * first clip's start to the last clip's end. Clip lengths come from the video metadata once known.
 */
export function flightCards(
  layers: readonly Layer[],
  durations: Readonly<Record<string, number>>,
): FlightCard[] {
  return flightGroups(layers)
    .map((g) => {
      let startMs = Infinity;
      let endMs = -Infinity;
      let estimated = false;
      for (const c of g.clips) {
        const d = durations[c.id];
        if (d === undefined) estimated = true;
        startMs = Math.min(startMs, clipStart(c));
        endMs = Math.max(endMs, clipStart(c) + (d ?? DEFAULT_CLIP_MS));
      }
      return {
        id: g.id,
        name: g.name,
        clips: g.clips,
        startMs,
        endMs,
        estimated,
        poster:
          g.clips[Math.floor(g.clips.length / 2)]?.poster ?? g.clips.find((c) => c.poster)?.poster,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

/** The flight holding a clip, or the first flight. */
export function flightOf(cards: readonly FlightCard[], clipId: string | null): FlightCard | null {
  return cards.find((f) => f.clips.some((c) => c.id === clipId)) ?? cards[0] ?? null;
}
