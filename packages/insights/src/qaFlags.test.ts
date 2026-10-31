import { describe, expect, it } from 'vitest';
import { qaFlagsFor, resultQaFlags, rmseLimit, type QaFlagContext } from './qaFlags';
import { CAPTURES, checkpoints, qaFile, result } from './testing';

const ctx = (qa: QaFlagContext['qa'], rmseLimitM: number | null = 0.1): QaFlagContext => ({
  qa,
  captures: CAPTURES,
  rmseLimitM,
});

describe('qaFlagsFor', () => {
  it('flags a later date nobody checked, never the earliest', () => {
    expect(qaFlagsFor('m2', ctx({}))).toEqual(['qa-unchecked']);
    expect(qaFlagsFor('m1', ctx({}))).toEqual([]);
    expect(qaFlagsFor('unknown', ctx({}))).toEqual([]);
  });

  it('flags a held date and a released one', () => {
    expect(
      qaFlagsFor(
        'm2',
        ctx({ m2: qaFile('m2', { status: 'hold', checkpoints: checkpoints(0.02) }) }),
      ),
    ).toEqual(['qa-hold']);
    expect(qaFlagsFor('m2', ctx({ m2: qaFile('m2', { status: 'fail' }) }))).toEqual([
      'qa-hold',
      'no-checkpoints',
    ]);
    expect(
      qaFlagsFor(
        'm2',
        ctx({ m2: qaFile('m2', { status: 'released', checkpoints: checkpoints(0.02) }) }),
      ),
    ).toEqual(['qa-released']);
  });

  it('flags a check at level Off as without a verdict', () => {
    expect(
      qaFlagsFor('m3', ctx({ m3: qaFile('m3', { level: 'off', status: 'unchecked' }) }, null)),
    ).toEqual(['qa-unchecked', 'no-checkpoints']);
  });

  it('flags checkpoint RMSE over the site limit', () => {
    expect(qaFlagsFor('m2', ctx({ m2: qaFile('m2', { checkpoints: checkpoints(0.15) }) }))).toEqual(
      ['rmse-over-limit'],
    );
    expect(qaFlagsFor('m2', ctx({ m2: qaFile('m2', { checkpoints: checkpoints(0.08) }) }))).toEqual(
      [],
    );
    expect(
      qaFlagsFor('m2', ctx({ m2: qaFile('m2', { checkpoints: checkpoints(0.15) }) }, null)),
    ).toEqual([]);
  });

  it('counts a check with zero checkpoints as none', () => {
    expect(qaFlagsFor('m2', ctx({ m2: qaFile('m2', { checkpoints: checkpoints(0, 0) }) }))).toEqual(
      ['no-checkpoints'],
    );
  });
});

describe('rmseLimit', () => {
  it('takes the site value over the level, none at Off', () => {
    expect(rmseLimit('moderate')).toBe(0.1);
    expect(rmseLimit('strict', 0.03)).toBe(0.03);
    expect(rmseLimit('off', 0.03)).toBeNull();
  });
});

describe('resultQaFlags', () => {
  it('gives the flags of the date a result is for, worked out when read', () => {
    const c = ctx({ m2: qaFile('m2', { status: 'hold' }) });
    expect(resultQaFlags(result('m2', 10), c)).toEqual(['qa-hold', 'no-checkpoints']);
    expect(resultQaFlags(result('m1', 10), c)).toEqual([]);
    expect(resultQaFlags({}, c)).toEqual([]);
  });
});
