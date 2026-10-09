import { formatQuantity } from '@aio/geo';
import { defaultSurveySettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { formatBearing, formatRow } from './readout';
import { effectiveUnits } from './units';

const { units, precision } = defaultSurveySettings();

describe('measurement units (formatting is @aio/geo)', () => {
  it('formats a measurement in its own units over the site units', () => {
    const own = effectiveUnits(units, { distance: 'us-ft', volume: 'yd3' });
    expect(own.area).toBe('m2');
    // 328.0833 US survey feet against 328.0840 international feet
    expect(formatQuantity(100, 'distance', own, precision)).toBe('328.083 US ft');
    expect(formatQuantity(100, 'distance', { ...own, distance: 'ft' }, precision)).toBe(
      '328.084 ft',
    );
    expect(formatQuantity(100, 'distance', units, precision)).toBe('100.000 m');
    expect(formatQuantity(1000, 'volume', own, precision)).toBe('1,308.0 yd³');
    expect(effectiveUnits(units)).toEqual(units);
  });

  it('formats bearings and readout rows', () => {
    expect(formatBearing(45.5)).toBe('045°30\'00"');
    expect(formatBearing(359.99999)).toBe('000°00\'00"');
    expect(
      formatRow(
        { key: 'cut', label: 'Cut', value: null, kind: 'volume', note: 'n/a' },
        units,
        precision,
      ),
    ).toBe('n/a');
    expect(
      formatRow({ key: 'cut', label: 'Cut', value: 1234.56, kind: 'volume' }, units, precision),
    ).toBe('1 234.6 m³');
  });
});
