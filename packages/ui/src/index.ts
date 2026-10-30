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
export {
  Button,
  IconButton,
  Kbd,
  SevChip,
  Switch,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
  type SevChipProps,
  type SwitchProps,
} from './controls';
export { Tip, TIP_DELAY_MS, TIP_SKIP_MS, type TipProps } from './Tip';
export { Menu, TYPEAHEAD_RESET_MS, type MenuEntry, type MenuItem, type MenuProps } from './Menu';
export { Dialog, openDialogCount, type DialogProps, type DialogSize } from './Dialog';
export * from './toast';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { Chip, type ChipKind, type ChipProps } from './Chip';
export { Row, type RowKind, type RowProps } from './Row';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export {
  PortalRoot,
  portalSurfaceAttrs,
  type PortalRootProps,
  type PortalSurfaceAttrs,
} from './portal';
export { contrastRatio } from './contrast';
export {
  ResizableSplit,
  SplitHandle,
  SNAP_MARGIN,
  SPLIT_STEP,
  SPLIT_PREFS_KEY,
  SPLIT_STEP_BIG,
  clampSplit,
  createSplitPrefs,
  keyStep,
  snapsToCollapse,
  splitPrefs,
  useResizableSplit,
  type ResizableSplitProps,
  type ResizableSplitState,
  type SplitLimits,
  type SplitOptions,
  type SplitPref,
  type SplitPrefsState,
  type SplitHandleProps,
} from './split';
export * from './format';
export { isMacPlatform, platformKeys } from './shortcut';
export * from './coords';
export * from './timeline/model';
export { generateTicks, pickTickStep, type Tick, type TickStep } from './timeline/ticks';
export { Timeline, RATES, type TimelineProps } from './timeline/Timeline';
export * from './timeline/lanes';
export { LaneTimeline, type LaneTimelineProps } from './timeline/LaneTimeline';
export * from './dates/calendarModel';
export { Calendar, type CalendarDay } from './dates/Calendar';
export { Popover, type PopoverProps } from './Popover';
export * from './tree/model';
export * from './tree/dateModel';
export {
  DatasetTree,
  VisibilityEye,
  isMenuKey,
  keyMenuPoint,
  menuPoint,
  type DatasetTreeProps,
  type GroupFold,
  type MeasureTreeProps,
  type MenuPoint,
} from './tree/DatasetTree';
export { RenameField } from './tree/RenameField';
export {
  DateTree,
  type DateFolderMenuRequest,
  type DateItemMenuRequest,
  type DateTreeProps,
} from './tree/DateTree';
export { RemoveDialog, type RemoveDialogProps } from './tree/RemoveDialog';
export { removeText, type RemoveText, type RemoveTextOptions } from './tree/removeText';
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

export * from './actions';
