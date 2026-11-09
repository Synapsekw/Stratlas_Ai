import type { Layer } from '@aio/schema';

/**
 * Layer kinds with no engine adapter because the app draws them itself (flight lines draw in
 * the desktop renderer's flight-line scene). The stage does not warn that these are skipped.
 */
const DRAWN_ELSEWHERE: ReadonlySet<Layer['kind']> = new Set(['flightline']);

export function isDrawnElsewhere(kind: Layer['kind']): boolean {
  return DRAWN_ELSEWHERE.has(kind);
}
