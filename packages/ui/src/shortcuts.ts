/**
 * Every keyboard shortcut of the app in one table: the key handlers ask it whether a key press is
 * theirs (`isShortcut`, `matchShortcut`), and Settings, Keyboard lists it. A shortcut belongs to
 * a scope (where it works); `shortcutConflicts` finds two shortcuts on the same key in scopes that
 * are live at the same time, unless one names the other in `shadows` (it wins on purpose).
 *
 * Key combos read `Ctrl+Shift+F`: modifiers `Ctrl` (Ctrl or Cmd), `Alt`, `Shift`, then one key:
 * a letter, a digit, or a name from `NAMED` (`Plus` and `Minus` for + and -). Shift must match
 * for letters and named keys; for symbols it is part of the character and is ignored.
 *
 * Handlers inside packages that cannot depend on @aio/ui (annotate, engine) keep their own key
 * checks; their rows here mirror them and say so in `owner`.
 */
import type { MessageKey } from './i18n';
import { isMacPlatform, platformKeys } from './shortcut';

export type ShortcutScope =
  | 'global'
  | 'scene'
  | 'road'
  | 'volumes'
  | 'issues'
  | 'issueList'
  | 'photo'
  | 'videoWindow'
  | 'videoAnnotate'
  | 'panorama'
  | 'review'
  | 'pdf'
  | 'lightbox'
  | 'palette'
  | 'agent'
  | 'dialog';

export interface Shortcut {
  id: string;
  scope: ShortcutScope;
  /** One or more combos that do the same thing, e.g. `['J', 'Down']`. */
  keys: readonly string[];
  /** What it does, for the keyboard map. */
  label: MessageKey;
  /** Shortcuts in a scope live at the same time that this one overrides on purpose. */
  shadows?: readonly string[];
  /** The package whose handler checks the key itself (it cannot import this table). */
  owner?: string;
}

/** Scopes in the order the keyboard map shows them, with their heading. */
export const SHORTCUT_SCOPES: readonly { scope: ShortcutScope; label: MessageKey }[] = [
  { scope: 'global', label: 'keys.scope.global' },
  { scope: 'scene', label: 'keys.scope.scene' },
  { scope: 'road', label: 'keys.scope.road' },
  { scope: 'volumes', label: 'keys.scope.volumes' },
  { scope: 'issues', label: 'keys.scope.issues' },
  { scope: 'issueList', label: 'keys.scope.issueList' },
  { scope: 'photo', label: 'keys.scope.photo' },
  { scope: 'lightbox', label: 'keys.scope.lightbox' },
  { scope: 'videoWindow', label: 'keys.scope.videoWindow' },
  { scope: 'videoAnnotate', label: 'keys.scope.videoAnnotate' },
  { scope: 'panorama', label: 'keys.scope.panorama' },
  { scope: 'review', label: 'keys.scope.review' },
  { scope: 'pdf', label: 'keys.scope.pdf' },
  { scope: 'palette', label: 'keys.scope.palette' },
  { scope: 'agent', label: 'keys.scope.agent' },
  { scope: 'dialog', label: 'keys.scope.dialog' },
];

/**
 * Scopes whose window-wide handlers run together (besides `global`, which runs with every
 * scope). Focus-bound scopes (a list, a viewer, a dialog) only meet `global`.
 */
export const CONCURRENT_SCOPES: readonly (readonly [ShortcutScope, ShortcutScope])[] = [
  ['scene', 'road'],
  ['scene', 'volumes'],
  ['scene', 'issues'],
  ['road', 'issues'],
  ['volumes', 'issues'],
  ['scene', 'panorama'],
];

export const SHORTCUTS = [
  // anywhere
  { id: 'global.palette', scope: 'global', keys: ['Ctrl+K'], label: 'keys.global.palette' },
  { id: 'global.sidebar', scope: 'global', keys: ['Ctrl+B'], label: 'keys.global.sidebar' },
  {
    id: 'global.rightPanel',
    scope: 'global',
    keys: ['Ctrl+Alt+B'],
    label: 'keys.global.rightPanel',
  },
  { id: 'global.playPause', scope: 'global', keys: ['Space'], label: 'keys.global.playPause' },

  // the 3D, map and split stage
  { id: 'scene.mode3d', scope: 'scene', keys: ['1'], label: 'keys.scene.mode3d' },
  { id: 'scene.modeMap', scope: 'scene', keys: ['2'], label: 'keys.scene.modeMap' },
  { id: 'scene.modeSplit', scope: 'scene', keys: ['3'], label: 'keys.scene.modeSplit' },
  { id: 'scene.home', scope: 'scene', keys: ['H'], label: 'keys.scene.home' },
  { id: 'scene.flySelection', scope: 'scene', keys: ['F'], label: 'keys.scene.flySelection' },
  { id: 'scene.measure', scope: 'scene', keys: ['M'], label: 'keys.scene.measure' },
  { id: 'scene.section', scope: 'scene', keys: ['X'], label: 'keys.scene.section' },
  { id: 'scene.labels', scope: 'scene', keys: ['L'], label: 'keys.scene.labels' },
  { id: 'scene.annotate', scope: 'scene', keys: ['A'], label: 'keys.scene.annotate' },
  { id: 'scene.video', scope: 'scene', keys: ['W'], label: 'keys.scene.video' },
  { id: 'scene.flightPaths', scope: 'scene', keys: ['P'], label: 'keys.scene.flightPaths' },
  { id: 'scene.telemetry', scope: 'scene', keys: ['D'], label: 'keys.scene.telemetry' },
  { id: 'scene.pins', scope: 'scene', keys: ['I'], label: 'keys.scene.pins' },
  { id: 'scene.timeline', scope: 'scene', keys: ['T'], label: 'keys.scene.timeline' },
  { id: 'scene.inside', scope: 'scene', keys: ['C'], label: 'keys.scene.inside' },
  { id: 'scene.escape', scope: 'scene', keys: ['Esc'], label: 'keys.scene.escape' },
  { id: 'scene.drawFinish', scope: 'scene', keys: ['Enter'], label: 'keys.scene.drawFinish' },
  { id: 'scene.drawUndo', scope: 'scene', keys: ['Backspace'], label: 'keys.scene.drawUndo' },
  {
    id: 'scene.perf',
    scope: 'scene',
    keys: ['Ctrl+Shift+F'],
    label: 'keys.scene.perf',
    owner: '@aio/engine',
  },

  // a road survey: these run before the stage's own keys
  {
    id: 'road.pci',
    scope: 'road',
    keys: ['P'],
    label: 'keys.road.pci',
    shadows: ['scene.flightPaths'],
  },
  {
    id: 'road.density',
    scope: 'road',
    keys: ['D'],
    label: 'keys.road.density',
    shadows: ['scene.telemetry'],
  },
  {
    id: 'road.measure',
    scope: 'road',
    keys: ['M'],
    label: 'keys.road.measure',
    shadows: ['scene.measure'],
  },
  {
    id: 'road.closeup',
    scope: 'road',
    keys: ['C'],
    label: 'keys.road.closeup',
    shadows: ['scene.inside'],
  },
  { id: 'road.next', scope: 'road', keys: ['Right'], label: 'keys.road.next' },
  { id: 'road.prev', scope: 'road', keys: ['Left'], label: 'keys.road.prev' },

  // editing a stockpile outline
  {
    id: 'volumes.deletePoint',
    scope: 'volumes',
    keys: ['Delete', 'Backspace'],
    label: 'keys.volumes.deletePoint',
    shadows: ['scene.drawUndo'],
  },
  {
    id: 'volumes.save',
    scope: 'volumes',
    keys: ['Enter'],
    label: 'keys.volumes.save',
    shadows: ['scene.drawFinish'],
  },
  {
    id: 'volumes.undo',
    scope: 'volumes',
    keys: ['Ctrl+Z'],
    label: 'keys.volumes.undo',
    shadows: ['issues.undo'],
  },

  // issue edits, wherever the issue register is open
  {
    id: 'issues.undo',
    scope: 'issues',
    keys: ['Ctrl+Z'],
    label: 'keys.issues.undo',
    owner: '@aio/annotate',
  },
  {
    id: 'issues.redo',
    scope: 'issues',
    keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    label: 'keys.issues.redo',
    owner: '@aio/annotate',
  },

  // the issue list has focus
  {
    id: 'issueList.next',
    scope: 'issueList',
    keys: ['Down', 'J'],
    label: 'keys.issueList.next',
    owner: '@aio/annotate',
  },
  {
    id: 'issueList.prev',
    scope: 'issueList',
    keys: ['Up', 'K'],
    label: 'keys.issueList.prev',
    owner: '@aio/annotate',
  },
  {
    id: 'issueList.first',
    scope: 'issueList',
    keys: ['Home'],
    label: 'keys.issueList.first',
    owner: '@aio/annotate',
  },
  {
    id: 'issueList.last',
    scope: 'issueList',
    keys: ['End'],
    label: 'keys.issueList.last',
    owner: '@aio/annotate',
  },
  {
    id: 'issueList.open',
    scope: 'issueList',
    keys: ['Enter'],
    label: 'keys.issueList.open',
    owner: '@aio/annotate',
  },
  {
    id: 'issueList.tick',
    scope: 'issueList',
    keys: ['Space'],
    label: 'keys.issueList.tick',
    owner: '@aio/annotate',
    shadows: ['global.playPause'],
  },

  // a photo with its marks (issue detail, Media)
  {
    id: 'photo.select',
    scope: 'photo',
    keys: ['V'],
    label: 'keys.tool.select',
    owner: '@aio/annotate',
  },
  { id: 'photo.box', scope: 'photo', keys: ['B'], label: 'keys.tool.box', owner: '@aio/annotate' },
  {
    id: 'photo.rotbox',
    scope: 'photo',
    keys: ['R'],
    label: 'keys.tool.rotbox',
    owner: '@aio/annotate',
  },
  {
    id: 'photo.polygon',
    scope: 'photo',
    keys: ['P'],
    label: 'keys.tool.polygon',
    owner: '@aio/annotate',
  },
  {
    id: 'photo.point',
    scope: 'photo',
    keys: ['O'],
    label: 'keys.tool.point',
    owner: '@aio/annotate',
  },
  { id: 'photo.fit', scope: 'photo', keys: ['F'], label: 'keys.view.fit', owner: '@aio/annotate' },
  {
    id: 'photo.zoomIn',
    scope: 'photo',
    keys: ['Plus'],
    label: 'keys.view.zoomIn',
    owner: '@aio/annotate',
  },
  {
    id: 'photo.zoomOut',
    scope: 'photo',
    keys: ['Minus'],
    label: 'keys.view.zoomOut',
    owner: '@aio/annotate',
  },
  {
    id: 'photo.overlay',
    scope: 'photo',
    keys: ['M'],
    label: 'keys.photo.overlay',
    owner: '@aio/annotate',
  },

  // the full-size photo
  { id: 'lightbox.close', scope: 'lightbox', keys: ['Esc'], label: 'keys.dialog.close' },
  { id: 'lightbox.next', scope: 'lightbox', keys: ['Right', 'PageDown'], label: 'keys.photo.next' },
  { id: 'lightbox.prev', scope: 'lightbox', keys: ['Left', 'PageUp'], label: 'keys.photo.prev' },
  { id: 'lightbox.fit', scope: 'lightbox', keys: ['F', '0'], label: 'keys.view.fit' },
  { id: 'lightbox.zoomIn', scope: 'lightbox', keys: ['Plus'], label: 'keys.view.zoomIn' },
  { id: 'lightbox.zoomOut', scope: 'lightbox', keys: ['Minus'], label: 'keys.view.zoomOut' },
  { id: 'lightbox.marks', scope: 'lightbox', keys: ['M'], label: 'keys.lightbox.marks' },

  // the floating video window has focus
  {
    id: 'videoWindow.move',
    scope: 'videoWindow',
    keys: ['Left', 'Right', 'Up', 'Down'],
    label: 'keys.videoWindow.move',
  },
  {
    id: 'videoWindow.moveFar',
    scope: 'videoWindow',
    keys: ['Shift+Left', 'Shift+Right', 'Shift+Up', 'Shift+Down'],
    label: 'keys.videoWindow.moveFar',
  },
  { id: 'videoWindow.grow', scope: 'videoWindow', keys: ['Plus'], label: 'keys.videoWindow.grow' },
  {
    id: 'videoWindow.shrink',
    scope: 'videoWindow',
    keys: ['Minus'],
    label: 'keys.videoWindow.shrink',
  },
  {
    id: 'videoWindow.reset',
    scope: 'videoWindow',
    keys: ['Home'],
    label: 'keys.videoWindow.reset',
  },

  // annotating on the video
  {
    id: 'videoAnnotate.select',
    scope: 'videoAnnotate',
    keys: ['V'],
    label: 'keys.tool.select',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.box',
    scope: 'videoAnnotate',
    keys: ['B'],
    label: 'keys.tool.box',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.polygon',
    scope: 'videoAnnotate',
    keys: ['P'],
    label: 'keys.tool.polygon',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.keyframe',
    scope: 'videoAnnotate',
    keys: ['K'],
    label: 'keys.videoAnnotate.keyframe',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.in',
    scope: 'videoAnnotate',
    keys: ['I'],
    label: 'keys.videoAnnotate.in',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.out',
    scope: 'videoAnnotate',
    keys: ['O'],
    label: 'keys.videoAnnotate.out',
    owner: '@aio/annotate',
  },
  {
    id: 'videoAnnotate.close',
    scope: 'videoAnnotate',
    keys: ['Esc'],
    label: 'keys.videoAnnotate.close',
    owner: '@aio/annotate',
  },

  // inside a 360 panorama
  {
    id: 'panorama.look',
    scope: 'panorama',
    keys: ['Left', 'Right', 'Up', 'Down'],
    label: 'keys.panorama.look',
    owner: '@aio/engine',
  },
  {
    id: 'panorama.zoom',
    scope: 'panorama',
    keys: ['Plus', 'Minus'],
    label: 'keys.panorama.zoom',
    owner: '@aio/engine',
  },
  {
    id: 'panorama.leave',
    scope: 'panorama',
    keys: ['Esc'],
    label: 'keys.panorama.leave',
    owner: '@aio/engine',
    shadows: ['scene.escape'],
  },

  // Detections: keyboard-first review (BLD-5)
  { id: 'review.next', scope: 'review', keys: ['J', 'Right', 'Down'], label: 'keys.review.next' },
  { id: 'review.prev', scope: 'review', keys: ['K', 'Left', 'Up'], label: 'keys.review.prev' },
  {
    id: 'review.nextSource',
    scope: 'review',
    keys: ['Shift+J', 'Shift+Right', 'Shift+Down', 'PageDown'],
    label: 'keys.review.nextSource',
  },
  {
    id: 'review.prevSource',
    scope: 'review',
    keys: ['Shift+K', 'Shift+Left', 'Shift+Up', 'PageUp'],
    label: 'keys.review.prevSource',
  },
  { id: 'review.accept', scope: 'review', keys: ['A', 'Enter'], label: 'keys.review.accept' },
  { id: 'review.link', scope: 'review', keys: ['L'], label: 'keys.review.link' },
  { id: 'review.reject', scope: 'review', keys: ['X'], label: 'keys.review.reject' },
  { id: 'review.reopen', scope: 'review', keys: ['Shift+R'], label: 'keys.review.reopen' },
  { id: 'review.delete', scope: 'review', keys: ['Delete'], label: 'keys.review.delete' },
  { id: 'review.uncertain', scope: 'review', keys: ['U'], label: 'keys.review.uncertain' },
  { id: 'review.classNext', scope: 'review', keys: ['C'], label: 'keys.review.classNext' },
  { id: 'review.classPrev', scope: 'review', keys: ['Shift+C'], label: 'keys.review.classPrev' },
  { id: 'review.note', scope: 'review', keys: ['N'], label: 'keys.review.note' },
  {
    id: 'review.severity',
    scope: 'review',
    keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    label: 'keys.review.severity',
  },
  { id: 'review.select', scope: 'review', keys: ['V'], label: 'keys.tool.select' },
  { id: 'review.box', scope: 'review', keys: ['B'], label: 'keys.tool.box' },
  { id: 'review.rotbox', scope: 'review', keys: ['R'], label: 'keys.tool.rotbox' },
  { id: 'review.polygon', scope: 'review', keys: ['P'], label: 'keys.tool.polygon' },
  { id: 'review.point', scope: 'review', keys: ['O'], label: 'keys.tool.point' },
  { id: 'review.mask', scope: 'review', keys: ['M'], label: 'keys.review.mask' },
  { id: 'review.fit', scope: 'review', keys: ['F'], label: 'keys.view.fit' },
  { id: 'review.undo', scope: 'review', keys: ['Ctrl+Z'], label: 'keys.review.undo' },
  {
    id: 'review.redo',
    scope: 'review',
    keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    label: 'keys.review.redo',
  },

  // a PDF report
  { id: 'pdf.next', scope: 'pdf', keys: ['PageDown', 'Right'], label: 'keys.pdf.next' },
  { id: 'pdf.prev', scope: 'pdf', keys: ['PageUp', 'Left'], label: 'keys.pdf.prev' },
  { id: 'pdf.first', scope: 'pdf', keys: ['Home'], label: 'keys.pdf.first' },
  { id: 'pdf.last', scope: 'pdf', keys: ['End'], label: 'keys.pdf.last' },
  { id: 'pdf.zoomIn', scope: 'pdf', keys: ['Plus'], label: 'keys.view.zoomIn' },
  { id: 'pdf.zoomOut', scope: 'pdf', keys: ['Minus'], label: 'keys.view.zoomOut' },
  { id: 'pdf.find', scope: 'pdf', keys: ['Ctrl+F'], label: 'keys.pdf.find' },

  // the command search
  { id: 'palette.move', scope: 'palette', keys: ['Up', 'Down'], label: 'keys.palette.move' },
  { id: 'palette.run', scope: 'palette', keys: ['Enter'], label: 'keys.palette.run' },
  { id: 'palette.close', scope: 'palette', keys: ['Esc'], label: 'keys.dialog.close' },

  // the agent's message box
  { id: 'agent.send', scope: 'agent', keys: ['Enter'], label: 'keys.agent.send' },
  { id: 'agent.newline', scope: 'agent', keys: ['Shift+Enter'], label: 'keys.agent.newline' },
  { id: 'agent.stop', scope: 'agent', keys: ['Esc'], label: 'keys.agent.stop' },

  // any dialog or popover
  { id: 'dialog.close', scope: 'dialog', keys: ['Esc'], label: 'keys.dialog.close' },
  { id: 'dialog.cycle', scope: 'dialog', keys: ['Tab', 'Shift+Tab'], label: 'keys.dialog.cycle' },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

/** Named keys and the `KeyboardEvent.key` values they stand for. */
const NAMED: Record<string, readonly string[]> = {
  Esc: ['Escape'],
  Enter: ['Enter'],
  Space: [' ', 'Spacebar'],
  Tab: ['Tab'],
  Backspace: ['Backspace'],
  Delete: ['Delete'],
  Up: ['ArrowUp'],
  Down: ['ArrowDown'],
  Left: ['ArrowLeft'],
  Right: ['ArrowRight'],
  PageUp: ['PageUp'],
  PageDown: ['PageDown'],
  Home: ['Home'],
  End: ['End'],
  Plus: ['+', '='],
  Minus: ['-', '_'],
};
/** Keys whose character already carries Shift (+ is Shift+= on most layouts). */
const SHIFT_FREE = new Set(['Plus', 'Minus']);

/** The parts of a `KeyboardEvent` a shortcut looks at. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Physical key (KeyB): macOS Option turns the character into another one (Option+B is "∫"). */
  code?: string;
}

interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseCombo(combo: string): Combo {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  for (const m of parts)
    if (m !== 'Ctrl' && m !== 'Alt' && m !== 'Shift')
      throw new Error(`Unknown modifier ${m} in ${combo}`);
  if (!(key in NAMED) && !/^[A-Z0-9]$/.test(key)) throw new Error(`Unknown key ${key} in ${combo}`);
  return {
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    key,
  };
}

/** Does a key press match one combo? */
export function comboMatches(combo: string, e: KeyLike): boolean {
  const c = parseCombo(combo);
  if (c.ctrl !== (e.ctrlKey || e.metaKey) || c.alt !== e.altKey) return false;
  if (!/^[0-9]$/.test(c.key) && !SHIFT_FREE.has(c.key) && c.shift !== e.shiftKey) return false;
  const named = NAMED[c.key];
  if (named) return named.includes(e.key);
  if (e.key.length === 1 && e.key.toUpperCase() === c.key) return true;
  // With Alt (Option) held, macOS reports another character; the physical key still says which.
  return e.altKey && (e.code === `Key${c.key}` || e.code === `Digit${c.key}`);
}

const byId = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  const s = byId.get(id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  return s;
}

/** Is this key press the shortcut `id`? */
export function isShortcut(id: ShortcutId, e: KeyLike): boolean {
  return shortcut(id).keys.some((k) => comboMatches(k, e));
}

/** The first shortcut of `scope` this key press matches, or null. */
export function matchShortcut(scope: ShortcutScope, e: KeyLike): ShortcutId | null {
  for (const s of SHORTCUTS)
    if (s.scope === scope && s.keys.some((k) => comboMatches(k, e))) return s.id;
  return null;
}

const SYMBOL: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Plus: '+',
  Minus: '-',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

/** A combo as people read it: `Ctrl Shift F`, `↑`; on macOS `⇧⌘F` (Ctrl is Cmd there). */
export function keyLabel(combo: string, mac: boolean = isMacPlatform()): string {
  const c = parseCombo(combo);
  const mods = [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift'].filter(Boolean);
  return platformKeys([...mods, SYMBOL[c.key] ?? c.key].join(' '), mac);
}

const ARIA: Record<string, string> = {
  Esc: 'Escape',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Plus: 'Plus',
  Minus: 'Minus',
};

/**
 * `aria-keyshortcuts` for a shortcut: `Control+K` (`Meta+K` on macOS), several combos separated
 * by spaces.
 */
export function ariaKeys(id: ShortcutId, mac: boolean = isMacPlatform()): string {
  return shortcut(id)
    .keys.map((k) => {
      const c = parseCombo(k);
      const mods = [
        c.ctrl && (mac ? 'Meta' : 'Control'),
        c.alt && 'Alt',
        c.shift && 'Shift',
      ].filter(Boolean);
      return [...mods, ARIA[c.key] ?? c.key].join('+');
    })
    .join(' ');
}

/** The first combo of a shortcut, as people read it (tool tips). */
export function shortcutHint(id: ShortcutId, mac: boolean = isMacPlatform()): string {
  return keyLabel(shortcut(id).keys[0] ?? '', mac);
}

/** A combo in one canonical spelling, so `Ctrl+Shift+Z` and `Shift+Ctrl+Z` compare equal. */
function canonical(combo: string): string {
  const c = parseCombo(combo);
  const shift = c.shift && !SHIFT_FREE.has(c.key);
  return `${c.ctrl ? 'Ctrl+' : ''}${c.alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${c.key}`;
}

function live(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b || a === 'global' || b === 'global') return true;
  return CONCURRENT_SCOPES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Two shortcuts on the same key in scopes that are live together, where neither shadows the
 * other: `"Space: global.playPause and issueList.tick"`. Empty when the table is clean.
 */
export function shortcutConflicts(list: readonly Shortcut[] = SHORTCUTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.id)) out.push(`${s.id}: id used twice`);
    seen.add(s.id);
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b || !live(a.scope, b.scope)) continue;
      if (a.shadows?.includes(b.id) || b.shadows?.includes(a.id)) continue;
      const keysA = new Set(a.keys.map(canonical));
      for (const k of b.keys.map(canonical))
        if (keysA.has(k)) out.push(`${k}: ${a.id} and ${b.id}`);
    }
  }
  return out;
}
