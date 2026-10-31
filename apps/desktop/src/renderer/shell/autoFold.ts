/**
 * The Layers column (the left sidebar's dataset tree beside the rail, UI revision W11) folds away
 * on its own in a narrow window while the Scene or a data screen is open (founder, 16 Oct 2026),
 * so the data gets the room; the 52 px rail stays. The person's own choice (the
 * `sidebarCollapsed` setting) always wins; once the person reopens a column the window folded,
 * it stays open (`sidebarReopened`, panelPrefs.ts). End-to-end runs pin it open
 * (`window.aio.flags.autoFold` is false) unless a spec asks for the fold. W12 replaces this with
 * the responsive bands.
 */

/** Window widths below this fold the Layers column on the screens that hold data. */
export const AUTO_FOLD_BELOW = 1280;

// `string & {}`: any screen name, with the data screens still offered by the editor
export type FoldScreen = 'scene' | 'issues' | 'inspect' | 'reports' | (string & {});

/** The screens whose data gets the sidebar's room in a narrow window. */
const DATA_SCREENS: ReadonlySet<string> = new Set(['scene', 'issues', 'inspect', 'reports']);

/** Whether the Layers column is folded away (the rail alone shows). */
export function sidebarFolded(i: {
  setting: boolean; // settings.sidebarCollapsed (the person's choice)
  windowWidth: number;
  screen: FoldScreen;
  autoFold: boolean; // window.aio.flags.autoFold
  reopened: boolean; // panelPrefs.sidebarReopened
}): boolean {
  if (i.setting) return true;
  return i.autoFold && !i.reopened && i.windowWidth < AUTO_FOLD_BELOW && DATA_SCREENS.has(i.screen);
}
