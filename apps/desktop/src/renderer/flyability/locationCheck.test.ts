import type { ExternalFinding } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { locationLine } from './locationCheck';

const ext = (o: Partial<ExternalFinding>): ExternalFinding => ({
  source: 'flyability',
  poi: 'p',
  snapshots: ['s'],
  wallDistanceM: 3.14,
  hitDistanceM: 3.2,
  locationCheck: 'agrees',
  ...o,
});

describe('locationLine', () => {
  it('a disagreeing finding shows the warning', () => {
    expect(locationLine(ext({ locationCheck: 'disagrees' }))).toMatchObject({
      text: 'fly.check.disagrees',
      tone: 'warn',
    });
    expect(locationLine(ext({ locationCheck: 'no-hit' }))).toMatchObject({
      text: 'fly.check.noHit',
      tone: 'warn',
    });
  });

  it('an agreeing finding shows wall and point distances', () => {
    expect(locationLine(ext({}))).toEqual({
      text: 'fly.check.wall',
      vars: { wall: '3.1 m', hit: '3.2 m' },
      tone: 'plain',
    });
  });

  it('the other states read plain', () => {
    expect(locationLine(ext({ locationCheck: 'unchecked' })).tone).toBe('plain');
    expect(locationLine(ext({ locationCheck: 'moved' })).text).toBe('fly.check.moved');
  });
});
