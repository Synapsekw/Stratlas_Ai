import { describe, expect, it } from 'vitest';
import type { Screen } from '../store';
import { DOCK_SCREENS, dockWindow, isDockScreen } from './dockScreens';

/** Every screen of the app and whether the agent column is on it. */
const SCREENS: Record<Screen, boolean> = {
  projects: false,
  welcome: false,
  // the Scene keeps the agent in its own right panel
  scene: false,
  issues: true,
  media: true,
  detections: true,
  reports: true,
  settings: false,
  globe: false,
};

describe('the screens with the agent column', () => {
  it('are Issues, Media, Detections and Reports, and no other', () => {
    for (const [screen, docked] of Object.entries(SCREENS) as [Screen, boolean][])
      expect(isDockScreen(screen), screen).toBe(docked);
    expect([...DOCK_SCREENS]).toEqual(['issues', 'media', 'detections', 'reports']);
  });

  it('bind the agent to the window each of them shows', () => {
    expect(dockWindow('issues')).toBe('issues');
    expect(dockWindow('media')).toBe('photo');
    expect(dockWindow('detections')).toBe('photo');
    expect(dockWindow('reports')).toBe('report');
  });
});
