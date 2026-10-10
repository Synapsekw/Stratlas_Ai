import { STREET_GLOBE_PALETTE } from '@aio/globe';
import { STREET } from '@aio/maps';
import { describe, expect, it } from 'vitest';
import { GLOBE_PALETTE } from './street';

describe('the Globe palette', () => {
  it('draws water, land, borders and the backdrop in the street style colours', () => {
    expect(GLOBE_PALETTE.water).toBe(STREET.water);
    expect(GLOBE_PALETTE.land).toBe(STREET.earth);
    expect(GLOBE_PALETTE.border).toBe(STREET.boundary);
    expect(GLOBE_PALETTE.space).toBe(STREET.background);
  });

  it('matches the copy @aio/globe keeps for when no palette is passed', () => {
    // @aio/globe may not depend on @aio/maps (SPEC section 2), so it holds the same numbers:
    // a change to the street style's land, water or border fails here until both agree
    expect(STREET_GLOBE_PALETTE).toEqual(GLOBE_PALETTE);
  });
});
