import type { AltitudePlan } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  heightsLine,
  heightsPrompt,
  needsTakeoff,
  offsetFromTakeoff,
  promptChoice,
} from './heights';

const plan = (over: Partial<AltitudePlan> = {}): AltitudePlan => ({
  files: 2,
  absolute: 2,
  relative: 2,
  datum: null,
  recommended: 'relative',
  takeoff: { x: 10, z: -5, relAltM: 0.2 },
  takeoffAbsAlt: 41.9,
  ...over,
});

describe('import heights', () => {
  it('asks for a take-off height only when relative altitude is the rule', () => {
    expect(needsTakeoff(plan())).toBe(true);
    expect(needsTakeoff(plan({ recommended: 'absolute' }))).toBe(false);
    expect(needsTakeoff(plan({ files: 0 }))).toBe(false);
  });

  it('proposes the model height under the take-off point, else the origin height', () => {
    expect(heightsPrompt(['a'], plan(), 100, 41.94)).toMatchObject({
      takeoffH: 141.9,
      takeoffFrom: 'terrain',
    });
    expect(heightsPrompt(['a'], plan(), 100, null)).toMatchObject({
      takeoffH: 100,
      takeoffFrom: 'origin',
    });
  });

  it('turns a take-off height into the datum offset that agrees with it', () => {
    // Al-Zour flight 1: take-off at EL 141.9, logged at absolute 41.9: EL = absolute + 100
    expect(offsetFromTakeoff(plan(), 141.9)).toBe(100);
    expect(offsetFromTakeoff(plan({ takeoffAbsAlt: null }), 141.9)).toBeNull();
  });

  it('sends where the take-off height came from', () => {
    const p = heightsPrompt(['a'], plan(), 100, 41.9);
    expect(promptChoice(p, { source: 'relative', takeoffH: 141.9, offsetM: 0 })).toEqual({
      source: 'relative',
      takeoffH: 141.9,
      takeoffFrom: 'terrain',
    });
    expect(promptChoice(p, { source: 'relative', takeoffH: 150, offsetM: 0 }).takeoffFrom).toBe(
      'typed',
    );
    const o = heightsPrompt(['a'], plan(), 100, null);
    expect(promptChoice(o, { source: 'relative', takeoffH: 100, offsetM: 0 }).takeoffFrom).toBe(
      'origin',
    );
    expect(promptChoice(p, { source: 'absolute', takeoffH: 0, offsetM: 100 })).toEqual({
      source: 'absolute',
      absAltOffsetM: 100,
    });
  });

  it('states the rule and warns when heights are not confirmed', () => {
    expect(heightsLine({ source: 'absolute', offsetM: 100, from: 'datum' })).toEqual({
      text: 'Heights: absolute altitude + 100.0 m (project vertical datum).',
      warn: false,
    });
    expect(heightsLine({ source: 'absolute', offsetM: 0, from: 'uncorrected' }).warn).toBe(true);
    expect(heightsLine({ source: 'relative', offsetM: 141.9, from: 'terrain' }).text).toBe(
      'Heights: relative altitude + take-off at H 141.9 m (the model height under the take-off point).',
    );
    expect(heightsLine({ source: 'relative', offsetM: 100, from: 'origin' }).warn).toBe(true);
  });
});
