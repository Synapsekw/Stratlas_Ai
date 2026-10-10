/** Severity token names, highest first. Colours live in tokens.css; models override at runtime. */
export const SEVERITY_TOKENS = ['--s5', '--s4', '--s3', '--s2', '--s1'] as const;

/** Layout constants shared by the shell and the stage. */
export const layout = {
  sidebarWidth: 252,
  sidebarCollapsedWidth: 52,
  titleBarHeight: 40,
  rightPanelWidth: 360,
} as const;

export const TOKENS_CSS_PATH = './tokens.css';

export { Icon, ICONS, type IconName, type IconProps, type IconSize } from './icons/Icon';
export { Compass, type CompassProps } from './Compass';
export { Kbd, SevChip, Switch, type SevChipProps, type SwitchProps } from './controls';
export * from './format';
export { isMacPlatform, platformKeys } from './shortcut';
export * from './coords';
export * from './timeline/model';
export { generateTicks, pickTickStep, type Tick, type TickStep } from './timeline/ticks';
export { Timeline, RATES, type TimelineProps } from './timeline/Timeline';
export * from './dates/calendarModel';
export { Calendar, type CalendarDay } from './dates/Calendar';
export * from './tree/model';
export * from './tree/dateModel';
export {
  DatasetTree,
  VisibilityEye,
  menuPoint,
  type DatasetTreeProps,
  type MenuPoint,
} from './tree/DatasetTree';
export {
  DateTree,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type DateTreeProps,
} from './tree/DateTree';
export { rankCommands, scoreMatch, type Command } from './palette/rank';
export * from './shortcuts';
export { announce, announced, LiveAnnouncer, type Politeness } from './announce';
export {
  arrowFocus,
  focusables,
  focusLost,
  keepFocusAlive,
  trapFocus,
  useFocusTrap,
  type FocusTrapOptions,
} from './focus';
export {
  catalogueProblems,
  directionOf,
  en as messagesEn,
  getLocale,
  placeholders,
  setLocale,
  t,
  useT,
  type Catalogue,
  type MessageKey,
  type Vars,
} from './i18n';
export {
  CommandPalette,
  type CommandPaletteProps,
  type PaletteCommand,
} from './palette/CommandPalette';
