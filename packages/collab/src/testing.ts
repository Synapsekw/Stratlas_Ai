/**
 * Test helpers: fictional actors, clock readings and ops (no journal, no keys). Synthetic only;
 * names are on the fictional list ("Rana Example", "Omar Sample", "Lina Test").
 */
import type { CollabTarget } from '@aio/schema';
import { refOfTarget, type CollabOp } from './project';

const dev = (c: string) => `d_${c.repeat(52)}`;
export const ACTORS = {
  rana: `a_${'r'.repeat(26)}`,
  omar: `a_${'o'.repeat(26)}`,
  lina: `a_${'l'.repeat(26)}`,
  vera: `a_${'v'.repeat(26)}`,
  cleo: `a_${'c'.repeat(26)}`,
} as const;

export const PEOPLE = [
  { actor: ACTORS.rana, name: 'Rana Example', initials: 'RE', role: 'owner' as const },
  { actor: ACTORS.omar, name: 'Omar Sample', initials: 'OS', role: 'reviewer' as const },
  { actor: ACTORS.lina, name: 'Lina Test', initials: 'LT', role: 'reviewer' as const },
  { actor: ACTORS.vera, name: 'Vera Viewer', initials: 'VV', role: 'viewer' as const },
  { actor: ACTORS.cleo, name: 'Cleo Client', initials: 'CC', role: 'client' as const },
];

export const roleOf = (a: string) => PEOPLE.find((p) => p.actor === a)?.role;

/** A clock reading at `n` seconds after a fixed start, on a device named by one letter. */
export function hlc(n: number, device = 'a'): string {
  return `${String(1_790_000_000_000 + n * 1000).padStart(13, '0')}.0000.${dev(device)}`;
}

let counter = 0;
/** An op as the projection reads it; ids are unique per call. */
export function op(
  kind: string,
  act: string,
  at: number,
  target: CollabTarget | { rec: string; id: string },
  payload?: unknown,
): CollabOp {
  counter++;
  const ref = 'kind' in target ? refOfTarget(target) : target;
  return {
    id: counter.toString(16).padStart(64, '0'),
    act,
    hlc: hlc(at),
    kind,
    target: ref,
    ...(payload === undefined ? {} : { payload }),
  };
}

export const F03: CollabTarget = { kind: 'issue', id: 'i_f03' };
export const F05: CollabTarget = { kind: 'issue', id: 'i_f05' };

/** A 64-hex stand-in for a content hash. */
export const hashOf = (s: string) =>
  s
    .padEnd(64, '0')
    .replace(/[^0-9a-f]/g, 'f')
    .slice(0, 64);
