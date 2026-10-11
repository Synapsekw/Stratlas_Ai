import type { WindowKind } from '@aio/schema';
import type { Screen } from '../store';

/**
 * The screens with the agent column on their right edge. The Scene is not one of them: it has the
 * agent in its own right panel.
 */
export const DOCK_SCREENS = ['issues', 'media', 'detections', 'reports'] as const;
export type DockScreen = (typeof DOCK_SCREENS)[number];

export function isDockScreen(screen: Screen): screen is DockScreen {
  return (DOCK_SCREENS as readonly Screen[]).includes(screen);
}

const DOCK_WINDOW: Record<DockScreen, WindowKind> = {
  issues: 'issues',
  media: 'photo',
  detections: 'photo',
  reports: 'report',
};

/** The window the agent is bound to on each of these screens: what the screen shows. */
export function dockWindow(screen: DockScreen): WindowKind {
  return DOCK_WINDOW[screen];
}
