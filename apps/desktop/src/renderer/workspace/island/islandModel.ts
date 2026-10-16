/** Pure state of the stage island: live priority, rest content, tool groups, open state. */
import type { StageMode } from '../../store';

export type GroupId =
  'view' | 'measure' | 'display' | 'clouds' | 'volumes' | 'video' | 'road' | 'annotate';

export type LiveItem =
  | { kind: 'tool'; label: string; reading: string | null }
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
  open: 'rest' | 'ready' | 'tools' | 'date';
  group: GroupId;
  preview: GroupId | null;
  swapped: boolean;
}

export type IslandEvent =
  | { type: 'near' }
  | { type: 'leave' }
  | { type: 'toggleTools' }
  | { type: 'openDate' }
  | { type: 'hoverGroup'; group: GroupId }
  | { type: 'pickGroup'; group: GroupId }
  | { type: 'swap' }
  | { type: 'liveChanged' }
  | { type: 'escape' };

export function islandReducer(s: IslandState, e: IslandEvent): IslandState {
  switch (e.type) {
    case 'near':
      return s.open === 'rest' ? { ...s, open: 'ready' } : s;
    // leave only closes the ready state: tools and date stay until chosen or escaped
    case 'leave':
      return s.open === 'ready' ? { ...s, open: 'rest', preview: null } : s;
    case 'toggleTools':
      return { ...s, open: s.open === 'tools' ? 'rest' : 'tools', preview: null };
    case 'openDate':
      return { ...s, open: 'date', preview: null };
    case 'hoverGroup':
      return { ...s, preview: e.group };
    case 'pickGroup':
      return { ...s, group: e.group, preview: null, open: 'rest' };
    case 'swap':
      return { ...s, swapped: !s.swapped };
    case 'liveChanged':
      return s.swapped ? { ...s, swapped: false } : s;
    case 'escape':
      return { ...s, open: 'rest', preview: null };
  }
}
