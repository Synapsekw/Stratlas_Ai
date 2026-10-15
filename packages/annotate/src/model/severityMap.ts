import type { Issue, SeverityModel } from '@aio/schema';

/**
 * A severity on another model (a class's issues move to a class with another scale): the same
 * level when the model has it, else the nearest (a tie takes the higher, the safe side);
 * uncertain stays uncertain where the model has it, else the highest level, for a person to grade.
 */
export function mapSeverity(sev: Issue['severity'], to: SeverityModel): Issue['severity'] {
  const values = to.levels.map((l) => l.value);
  const top = Math.max(...values);
  if (sev === 'uncertain') return to.uncertain ? 'uncertain' : top;
  if (values.includes(sev)) return sev;
  let best = top;
  let gap = Infinity;
  for (const v of values) {
    const g = Math.abs(v - sev);
    if (g < gap || (g === gap && v > best)) {
      best = v;
      gap = g;
    }
  }
  return best;
}
