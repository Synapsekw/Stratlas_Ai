import { describe, expect, it } from 'vitest';
import { AUTO_FOLD_BELOW, sidebarFolded } from './autoFold';

const SCENE = {
  setting: false,
  windowWidth: 1100,
  screen: 'scene',
  autoFold: true,
  reopened: false,
};

describe('the sidebar folds to its rail on its own', () => {
  it('folds below 1280 px on the Scene', () => {
    expect(AUTO_FOLD_BELOW).toBe(1280);
    expect(sidebarFolded(SCENE)).toBe(true);
  });

  it('stays open once the person reopened it', () => {
    expect(sidebarFolded({ ...SCENE, reopened: true })).toBe(false);
  });

  it('stays open from 1280 px up', () => {
    expect(sidebarFolded({ ...SCENE, windowWidth: 1280 })).toBe(false);
    expect(sidebarFolded({ ...SCENE, windowWidth: 1279 })).toBe(true);
  });

  it('folds on the data screens, not on Settings or the projects', () => {
    for (const screen of ['issues', 'inspect', 'reports'])
      expect(sidebarFolded({ ...SCENE, screen })).toBe(true);
    for (const screen of ['settings', 'projects', 'welcome', 'globe'])
      expect(sidebarFolded({ ...SCENE, screen })).toBe(false);
  });

  it('never folds on its own when the flag is off (e2e pins it open)', () => {
    expect(sidebarFolded({ ...SCENE, autoFold: false })).toBe(false);
  });

  it("keeps the person's own choice to fold it at any width", () => {
    for (const windowWidth of [1100, 1280, 1920])
      for (const screen of ['scene', 'settings'])
        expect(sidebarFolded({ ...SCENE, setting: true, windowWidth, screen })).toBe(true);
    expect(sidebarFolded({ ...SCENE, setting: true, reopened: true, autoFold: false })).toBe(true);
  });
});
