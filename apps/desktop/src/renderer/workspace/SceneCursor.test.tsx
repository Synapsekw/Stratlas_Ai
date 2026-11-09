// @vitest-environment jsdom
import { defaultSurveySettings } from '@aio/schema';
import { frameOf } from '../survey/measureScene';
import { describe, expect, it } from 'vitest';
import { siteCursorText, siteDisplay } from '../survey/SiteSettings';
import { cursorFrameLabel, cursorReadoutText, elevationText } from './SceneCursor';

describe('cursor elevation', () => {
  it('cursor without site settings formats through formatQuantity', () => {
    expect(elevationText(12.34)).toBe('12.3 m');
  });

  it('cursor follows feet', () => {
    const s = defaultSurveySettings();
    siteDisplay.setState({
      exists: true,
      settings: { ...s, units: { ...s.units, distance: 'ft' } },
      transformer: null,
      projector: null,
    });
    expect(siteCursorText(100, 200, 10)).toContain('32.808');
    siteDisplay.setState({ exists: false, settings: null });
  });
});

describe('cursor in a local space', () => {
  const local = frameOf({ crs: { local: 'flyability' }, origin: [0, 0, 0] });
  const utm = frameOf({ crs: { epsg: 32640 }, origin: [500000, 2700000, 0] });

  it('names the frame by the active space, not the project', () => {
    expect(cursorFrameLabel({ local: 'flyability' })).toBe('Local frame');
    expect(cursorFrameLabel({ epsg: 32640 })).toBe('UTM 40N · WGS84');
  });

  it('reads plain metres on X, Y, Z from the origin: file x east, y north, z up', () => {
    // scene point (x east, y up, z south) -> file (x, -z, y)
    expect(cursorReadoutText(local, [1.5, 3, -2])).toBe('X 1.50  Y 2.00  Z 3.00');
  });

  it('keeps the easting and northing of a georeferenced frame', () => {
    expect(cursorReadoutText(utm, [10, 4, -20])).toContain('E 500 010.0');
  });
});
