import type { AntennaUnit } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { isAntennaDrawn } from './antennaVisibility';

const unit = (id: string, kind: AntennaUnit['kind']) => ({ id, kind }) as AntennaUnit;

describe('isAntennaDrawn', () => {
  it('draws the selected unit even when hidden or soloed out, and only while selected', () => {
    const u = unit('a', 'short');
    expect(isAntennaDrawn({ selected: null, hidden: { a: true }, solo: null }, u)).toBe(false);
    expect(isAntennaDrawn({ selected: 'a', hidden: { a: true }, solo: null }, u)).toBe(true);
    expect(isAntennaDrawn({ selected: null, hidden: {}, solo: 'panel' }, u)).toBe(false);
    expect(isAntennaDrawn({ selected: 'a', hidden: {}, solo: 'panel' }, u)).toBe(true);
  });

  it('draws an unhidden unit of the soloed kind, or of any kind without solo', () => {
    expect(isAntennaDrawn({ selected: null, hidden: {}, solo: 'short' }, unit('a', 'short'))).toBe(
      true,
    );
    expect(isAntennaDrawn({ selected: null, hidden: {}, solo: null }, unit('a', 'dish'))).toBe(
      true,
    );
  });
});
