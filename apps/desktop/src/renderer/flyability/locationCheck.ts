import type { ExternalFinding } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

export interface LocationLine {
  text: MessageKey;
  vars: Record<string, string>;
  tone: 'warn' | 'plain';
}

const metres = (n: number): string => `${n.toFixed(1)} m`;

/**
 * What the location check of an imported finding says: a warning when the recorded place does not
 * match the cloud (or the cloud has nothing there), otherwise a plain line. An agreeing finding
 * reads its wall distance and how far the cloud point is from the recorded place.
 */
export function locationLine(ext: ExternalFinding): LocationLine {
  switch (ext.locationCheck) {
    case 'disagrees':
      return { text: 'fly.check.disagrees', vars: {}, tone: 'warn' };
    case 'no-hit':
      return { text: 'fly.check.noHit', vars: {}, tone: 'warn' };
    case 'moved':
      return { text: 'fly.check.moved', vars: {}, tone: 'plain' };
    case 'agrees':
      if (ext.wallDistanceM !== null && ext.hitDistanceM !== null) {
        return {
          text: 'fly.check.wall',
          vars: { wall: metres(ext.wallDistanceM), hit: metres(ext.hitDistanceM) },
          tone: 'plain',
        };
      }
      return { text: 'fly.check.unchecked', vars: {}, tone: 'plain' };
    case 'unchecked':
      return { text: 'fly.check.unchecked', vars: {}, tone: 'plain' };
  }
}
