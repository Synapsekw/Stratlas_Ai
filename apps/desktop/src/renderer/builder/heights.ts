import type { AltitudeChoice, AltitudePlan, ImportHeights } from '@aio/schema';

/**
 * Camera heights in the import UI (data-conventions section 3a): what to ask before an import,
 * and how the summary states the rule it applied.
 */

const m1 = (v: number) => `${v < 0 ? '-' : ''}${Math.abs(v).toFixed(1)}`;

/** Does this import need the person to confirm a take-off height first? */
export function needsTakeoff(plan: AltitudePlan): boolean {
  return plan.files > 0 && plan.recommended === 'relative';
}

export interface HeightsPrompt {
  paths: string[];
  plan: AltitudePlan;
  originH: number;
  /** Proposed take-off height H: the model under the take-off point, else the origin height. */
  takeoffH: number;
  takeoffFrom: 'terrain' | 'origin';
}

/** The prompt for a plan, given the model height (local y) under its take-off point, if any. */
export function heightsPrompt(
  paths: readonly string[],
  plan: AltitudePlan,
  originH: number,
  terrainY: number | null,
): HeightsPrompt {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    paths: [...paths],
    plan,
    originH,
    takeoffH: r(originH + (terrainY ?? 0)),
    takeoffFrom: terrainY === null ? 'origin' : 'terrain',
  };
}

/**
 * The datum offset that makes absolute altitude agree with a take-off height: the take-off point's
 * project height minus the absolute altitude the aircraft logged there.
 */
export function offsetFromTakeoff(plan: AltitudePlan, takeoffH: number): number | null {
  return plan.takeoffAbsAlt === null
    ? null
    : Math.round((takeoffH - plan.takeoffAbsAlt) * 100) / 100;
}

/** The choice the prompt sends with `builder:import`. */
export function promptChoice(
  p: HeightsPrompt,
  form: { source: 'relative' | 'absolute'; takeoffH: number; offsetM: number },
): AltitudeChoice {
  if (form.source === 'absolute') return { source: 'absolute', absAltOffsetM: form.offsetM };
  const typed = Math.abs(form.takeoffH - p.takeoffH) > 1e-6;
  return {
    source: 'relative',
    takeoffH: form.takeoffH,
    takeoffFrom: typed ? 'typed' : p.takeoffFrom,
  };
}

/** The summary line for the rule an import applied; `warn` when the heights are unconfirmed. */
export function heightsLine(h: ImportHeights): { text: string; warn: boolean } {
  if (h.source === 'absolute') {
    if (h.from === 'uncorrected')
      return {
        text: 'Heights: absolute altitude as logged, with no vertical datum. They can be tens of metres off; import again with relative altitude and a take-off height, or set an offset.',
        warn: true,
      };
    return {
      text: `Heights: absolute altitude ${h.offsetM < 0 ? '-' : '+'} ${m1(Math.abs(h.offsetM))} m (project vertical datum${h.note ? `: ${h.note}` : ''}).`,
      warn: false,
    };
  }
  const where =
    h.from === 'terrain'
      ? 'the model height under the take-off point'
      : h.from === 'typed'
        ? 'typed at import'
        : 'the project origin height, not confirmed';
  return {
    text: `Heights: relative altitude + take-off at H ${m1(h.offsetM)} m (${where}).`,
    warn: h.from === 'origin',
  };
}
