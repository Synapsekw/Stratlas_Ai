/**
 * Which side panels are folded away, remembered on this machine.
 *
 * The left sidebar's state is the `sidebarCollapsed` setting (settings.json). The right panel's
 * state and the agent column's live here, in the window's local storage, because settings.json
 * keeps the key set older builds read (docs/release/UPGRADE-POLICY.md, "Settings and downgrade"):
 * like the stage layout and the timeline choice, they are layout preferences of this workstation,
 * not settings.
 */
export interface PanelPrefs {
  /** The right panel of the Scene (selection, issues, agent) is folded away. */
  rightCollapsed: boolean;
  /** The agent column of Issues, Media, Detections and Reports is folded away. */
  agentDockCollapsed: boolean;
}

/** The Scene's panel is shown; the agent column takes room from a screen only once asked for. */
export const DEFAULT_PANEL_PREFS: PanelPrefs = { rightCollapsed: false, agentDockCollapsed: true };

export const PANEL_PREFS_KEY = 'quadrion.panels';

export type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The window's local storage, or null where there is none (tests in Node, blocked storage). */
export function browserStorage(): PanelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Anything that is not a stored choice falls back to its default, field by field: a value stored
 * before the agent column existed keeps its right panel choice.
 */
export function parsePanelPrefs(raw: string | null | undefined): PanelPrefs {
  if (!raw) return DEFAULT_PANEL_PREFS;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return DEFAULT_PANEL_PREFS;
    const { rightCollapsed: right, agentDockCollapsed: dock } = v as Record<string, unknown>;
    return {
      rightCollapsed: typeof right === 'boolean' ? right : DEFAULT_PANEL_PREFS.rightCollapsed,
      agentDockCollapsed: typeof dock === 'boolean' ? dock : DEFAULT_PANEL_PREFS.agentDockCollapsed,
    };
  } catch {
    return DEFAULT_PANEL_PREFS;
  }
}

export function readPanelPrefs(storage: PanelStorage | null): PanelPrefs {
  try {
    return parsePanelPrefs(storage?.getItem(PANEL_PREFS_KEY));
  } catch {
    // blocked storage: start with the defaults
    return DEFAULT_PANEL_PREFS;
  }
}

export function writePanelPrefs(storage: PanelStorage | null, prefs: PanelPrefs): void {
  try {
    storage?.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private window or blocked storage: the choice is just not remembered
  }
}
