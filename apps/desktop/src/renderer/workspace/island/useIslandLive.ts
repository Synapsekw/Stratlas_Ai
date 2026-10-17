/**
 * What is live in the app right now, as the island's `LiveItem`s: the survey tool being drawn (or
 * the quick measure), the playing clip, the running jobs and a network that is not healthy. The
 * pure `liveItems` decides the list; `useIslandLive` reads the real stores into it. The survey date
 * is not a live item: it stays visible beside a live reading.
 */
import { TOOL_LABELS } from '@aio/survey';
import type { MeasurementTool } from '@aio/schema';
import { t } from '@aio/ui';
import { telemetryAt } from '@aio/video';
import { clipStartMs, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { isActive } from '../../jobs';
import { useMedia } from '../../media';
import { projectJobs } from '../../processing/model';
import { jobTitle } from '../../processing/pipelines';
import { useJobs, useShell } from '../../shell';
import { useNetworkUp } from '../../shell/connection';
import { liveReading, useMeasure } from '../../survey/measureStore';
import type { LiveItem } from './islandModel';

/** How long "Back online" shows (D3). */
export const BACK_MS = 2000;

type ConnectionState = Extract<LiveItem, { kind: 'connection' }>['state'];

export interface LiveInput {
  tool: { label: string; reading: string | null } | null;
  clip: { name: string; progress: number; telemetry: string | null } | null;
  /** Running jobs in any order; `liveItems` orders them by start. */
  jobs: { id: string; label: string; progress: number; startedMs: number }[];
  connection: ConnectionState | null;
}

const unit = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** The live items in the order `pickLive` expects: jobs oldest first, so the newest is last. */
export function liveItems(input: LiveInput): LiveItem[] {
  const out: LiveItem[] = [];
  if (input.tool) out.push({ kind: 'tool', ...input.tool });
  if (input.clip) {
    out.push({
      kind: 'playback',
      clip: input.clip.name,
      progress: unit(input.clip.progress),
      telemetry: input.clip.telemetry,
    });
  }
  [...input.jobs]
    .sort((a, b) => a.startedMs - b.startedMs)
    .forEach((j) =>
      out.push({ kind: 'job', id: j.id, label: j.label, progress: unit(j.progress), more: 0 }),
    );
  if (input.connection) out.push({ kind: 'connection', state: input.connection });
  return out;
}

/** "ALT 31 m · SPD 3.2 m/s" for the playing clip (D30). */
export function playbackTelemetry(altitudeM: number, speedMps: number): string {
  return t('island.telemetry', { alt: Math.round(altitudeM), speed: speedMps.toFixed(1) });
}

/** How often the island follows the playhead while a clip plays. */
const PLAYBACK_STEP_MS = 250;

/**
 * The playhead in the island's steps: the playhead moves on every frame, the island's line (its
 * bar and telemetry) four times a second, so the island does not draw again on every frame.
 */
export function playbackClock(nowMs: number): number {
  return Math.floor(nowMs / PLAYBACK_STEP_MS) * PLAYBACK_STEP_MS;
}

/**
 * A stable key of the live pair the island shows (kinds, plus the job's id and the connection
 * state): readings and progress ticking do not change it. Task 5 sends `liveChanged` when it
 * changes, so a swap does not outlive the pair it swapped.
 */
export function livePairKey(items: readonly LiveItem[]): string {
  const jobs = items.filter((i) => i.kind === 'job');
  const ranked: LiveItem[] = [];
  for (const kind of ['tool', 'playback', 'job', 'connection'] as const) {
    const it = kind === 'job' ? jobs[jobs.length - 1] : items.find((i) => i.kind === kind);
    if (it) ranked.push(it);
  }
  return ranked
    .slice(0, 2)
    .map((i) => {
      if (i.kind === 'job') return `job:${i.id}`;
      if (i.kind === 'connection') return `connection:${i.state}`;
      return i.kind;
    })
    .join('|');
}

/**
 * Offline while the network is down; "back" for `BACK_MS` after it returns; nothing otherwise.
 * Outside React so it can be tested with fake timers.
 */
export function createBackOnline() {
  let current: ConnectionState | null = null;
  let up = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: ConnectionState | null) => {
    if (next === current) return;
    current = next;
    listeners.forEach((l) => {
      l();
    });
  };
  return {
    /**
     * `nowUp` is the real network; `quiet` hides the item (offline only is on). "Back" shows only
     * on a real down-to-up change while not quiet.
     */
    update(nowUp: boolean, quiet = false) {
      const wentUp = nowUp && !up;
      up = nowUp;
      if (quiet || !nowUp) {
        clearTimeout(timer);
        set(quiet ? null : 'offline');
      } else if (wentUp) {
        clearTimeout(timer);
        set('back');
        timer = setTimeout(() => {
          set(null);
        }, BACK_MS);
      }
    },
    get: (): ConnectionState | null => current,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

const back = createBackOnline();
const subscribeBack = (l: () => void) => back.subscribe(l);
const getBack = () => back.get();

// "Reconnecting..." (`state: 'reconnecting'`) has no source yet: navigator.onLine is the only
// network signal, so only offline and back are produced.
function useConnectionLive(): ConnectionState | null {
  const up = useNetworkUp();
  // offline only is the person's choice, not an unhealthy connection
  const chosen = useShell((s) => s.settings.offlineOnly === true);
  useEffect(() => {
    back.update(up, chosen);
  }, [up, chosen]);
  return useSyncExternalStore(subscribeBack, getBack, () => null);
}

/** The name the drawing bar shows: the template's name, else the tool's. */
export function toolLabel(tool: MeasurementTool, template: { name: string } | null): string {
  return template?.name ?? TOOL_LABELS[tool];
}

/** The live survey tool and its reading, from the measuring store (M and Distance included). */
function useToolLive(): LiveInput['tool'] {
  const active = useMeasure((s) => s.tool);
  const reading = useMeasure(liveReading);
  return useMemo(
    () => (active ? { label: toolLabel(active.tool, active.template), reading } : null),
    [active, reading],
  );
}

function usePlaybackLive(): LiveInput['clip'] {
  const playing = useWorkspace((s) => s.playing);
  const activeClip = useWorkspace((s) => s.activeClip);
  // the playhead in steps (playbackClock): only playing, the island follows it
  const nowMs = useWorkspace((s) => (s.playing ? playbackClock(s.nowMs) : 0));
  const project = useWorkspace((s) => s.project);
  const { durations, flights } = useMedia(project);
  return useMemo(() => {
    if (!playing || !activeClip || !project) return null;
    const layer = project.manifest.layers.find((l) => l.id === activeClip);
    if (layer?.kind !== 'video') return null;
    const dur = durations[layer.id];
    const progress = dur ? (nowMs - clipStartMs(layer)) / dur : 0;
    const samples = flights[layer.id];
    const tm = samples?.length ? telemetryAt(samples, nowMs - layer.flight.startUtcMs) : null;
    return {
      name: layer.name,
      progress,
      telemetry: tm ? playbackTelemetry(tm.altitudeM, tm.speedMps) : null,
    };
  }, [playing, activeClip, nowMs, project, durations, flights]);
}

function useJobsLive(): LiveInput['jobs'] {
  const all = useJobs((s) => s.jobs);
  const root = useWorkspace((s) => s.project?.root ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  return useMemo(
    () =>
      projectJobs(all, pkg ? null : root)
        .running.filter(isActive)
        .map((j) => ({
          id: j.id,
          label: jobTitle(j.pipeline),
          progress: j.progress,
          startedMs: Date.parse(j.createdAt) || 0,
        })),
    [all, root, pkg],
  );
}

/** The island's live items, read from the measuring, playback, jobs and connection stores. */
export function useIslandLive(): LiveItem[] {
  const tool = useToolLive();
  const clip = usePlaybackLive();
  const jobs = useJobsLive();
  const connection = useConnectionLive();
  return useMemo(() => liveItems({ tool, clip, jobs, connection }), [tool, clip, jobs, connection]);
}
