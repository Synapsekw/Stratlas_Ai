/** Pure state of the stage notch: live priority, rest content, tool groups, open and pinned. */
import type { StageMode } from '../../store';

export type GroupId =
  'view' | 'measure' | 'display' | 'clouds' | 'volumes' | 'video' | 'road' | 'annotate';

/** Whose tool a live `tool` item is: the survey tools (the default), the road's measure, Annotate. */
export type ToolSource = 'measure' | 'road' | 'annotate';

export type LiveItem =
  | { kind: 'tool'; label: string; reading: string | null; source?: ToolSource }
  | { kind: 'playback'; clip: string; progress: number; telemetry: string | null }
  | { kind: 'job'; id: string; label: string; progress: number; more: number }
  | { kind: 'connection'; state: 'offline' | 'reconnecting' | 'back' };

const PRIORITY: LiveItem['kind'][] = ['tool', 'playback', 'job', 'connection'];

/**
 * The two live readings to show: the highest priority one and the next. Running jobs collapse
 * into the newest (last in the list); for the other kinds the first in the list wins. Send
 * `liveChanged` to the reducer when the picked pair changes, so a swap does not outlive it with `more` counting the others.
 */
export function pickLive(items: readonly LiveItem[]): {
  primary: LiveItem | null;
  secondary: LiveItem | null;
} {
  const jobs = items.filter((i) => i.kind === 'job');
  const ranked: LiveItem[] = [];
  for (const kind of PRIORITY) {
    if (kind === 'job') {
      const newest = jobs[jobs.length - 1];
      if (newest) ranked.push({ ...newest, more: jobs.length - 1 });
    } else {
      const first = items.find((i) => i.kind === kind);
      if (first) ranked.push(first);
    }
  }
  return { primary: ranked[0] ?? null, secondary: ranked[1] ?? null };
}

export type IslandRest = 'dots' | 'date' | 'dateSteps';

export function islandRest(dateCount: number): IslandRest {
  if (dateCount <= 0) return 'dots';
  return dateCount === 1 ? 'date' : 'dateSteps';
}

export function islandGroups(input: {
  map: boolean;
  mode: StageMode;
  clouds: boolean;
  volumes: boolean;
  video: boolean;
  road: boolean;
  pkg: boolean;
}): GroupId[] {
  const groups: GroupId[] = ['view', 'measure', 'display'];
  // the map has no point clouds or volumes
  if (input.clouds && !input.map) groups.push('clouds');
  if (input.volumes && !input.map) groups.push('volumes');
  if (input.video) groups.push('video');
  if (input.road && input.mode !== '3d') groups.push('road');
  if (!input.pkg) groups.push('annotate');
  return groups;
}

export interface IslandState {
  /** At rest the notch's one line; `tools` adds the group tabs and a quick row; `date` the calendar. */
  open: 'rest' | 'tools' | 'date';
  group: GroupId;
  preview: GroupId | null;
  swapped: boolean;
  /** Kept open (on this computer): leaving, a press outside, Esc and a pick leave it open. */
  pinned: boolean;
}

/** At rest, or open with its tools when it was left pinned. */
export function islandInitial(pinned: boolean): IslandState {
  return { open: pinned ? 'tools' : 'rest', group: 'view', preview: null, swapped: false, pinned };
}

export type IslandEvent =
  | { type: 'toggleTools' }
  | { type: 'openDate' }
  | { type: 'hoverGroup'; group: GroupId }
  | { type: 'pickGroup'; group: GroupId }
  | { type: 'pin'; on: boolean }
  | { type: 'swap' }
  | { type: 'liveChanged' }
  | { type: 'escape' }
  | { type: 'close' };

export function islandReducer(s: IslandState, e: IslandEvent): IslandState {
  switch (e.type) {
    case 'toggleTools':
      if (s.pinned) return { ...s, open: 'tools' };
      return { ...s, open: s.open === 'tools' ? 'rest' : 'tools', preview: null };
    case 'openDate':
      return { ...s, open: 'date', preview: null };
    case 'hoverGroup':
      return { ...s, preview: e.group };
    // picked, the group's workbench opens and the notch rests unless pinned (Island.tsx)
    case 'pickGroup':
      return { ...s, group: e.group, preview: null };
    // pinned it opens; let go, it stays open until a press outside, Esc, Close or a pick
    case 'pin':
      return e.on ? { ...s, pinned: true, open: 'tools' } : { ...s, pinned: false };
    case 'swap':
      return { ...s, swapped: !s.swapped };
    case 'liveChanged':
      return s.swapped ? { ...s, swapped: false } : s;
    // pinned, Esc leaves the calendar for the tools and keeps them
    case 'escape':
      return { ...s, open: s.pinned ? 'tools' : 'rest', preview: null };
    // Close says it outright: the notch rests and is no longer kept open
    case 'close':
      return { ...s, open: 'rest', preview: null, pinned: false };
  }
}
