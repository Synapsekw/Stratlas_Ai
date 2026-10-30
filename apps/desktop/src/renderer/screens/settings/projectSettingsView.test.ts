import { describe, expect, it } from 'vitest';
import { projectMapKey } from './projectSettingsView';

describe('projectMapKey', () => {
  it('names each street map state of the open project', () => {
    expect(projectMapKey('detail')).toBe('settings.project.maps.detail');
    expect(projectMapKey('overview')).toBe('settings.project.maps.overview');
    expect(projectMapKey('none')).toBe('settings.project.maps.none');
    expect(projectMapKey('no-location')).toBe('settings.project.maps.noLocation');
  });

  it('a project outside the check (a demo) says how the check works', () => {
    expect(projectMapKey(undefined)).toBe('settings.project.maps.unknown');
  });
});
