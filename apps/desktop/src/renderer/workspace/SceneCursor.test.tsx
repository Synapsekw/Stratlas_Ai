// @vitest-environment jsdom
import { defaultSurveySettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { siteCursorText, siteDisplay } from '../survey/SiteSettings';
import { elevationText } from './SceneCursor';

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
