import { describe, expect, it } from 'vitest';
import { externalLinkAllowed } from '../../main/popup';
import { portalReportUrl, screenId } from './portalReport';

describe('screenId', () => {
  it('names the stage mode in a scene', () => {
    expect(screenId({ screen: 'scene', stageMode: 'map', settingsPage: null })).toBe('scene:map');
  });
  it('names the Settings page', () => {
    expect(screenId({ screen: 'settings', stageMode: '3d', settingsPage: 'privacy' })).toBe(
      'settings:privacy',
    );
    expect(screenId({ screen: 'settings', stageMode: '3d', settingsPage: null })).toBe('settings');
  });
  it('uses the screen name otherwise', () => {
    expect(screenId({ screen: 'projects', stageMode: '3d', settingsPage: null })).toBe('projects');
  });
});

describe('portalReportUrl', () => {
  it('carries the build and the screen', () => {
    expect(portalReportUrl('0.25.0', 'scene:map')).toBe(
      'https://quadrion.ai/portal/report/?build=0.25.0&screen=scene:map',
    );
  });
  it('says unknown for an empty version', () => {
    expect(portalReportUrl('', 'projects')).toBe(
      'https://quadrion.ai/portal/report/?build=unknown&screen=projects',
    );
  });
  it('encodes what is not URL safe', () => {
    expect(portalReportUrl('1.0 beta&x', 'a')).toContain('build=1.0%20beta%26x');
  });
  it('is a link the app is allowed to open', () => {
    expect(externalLinkAllowed(portalReportUrl('0.25.0', 'scene:map'))).toBe(true);
  });
});
