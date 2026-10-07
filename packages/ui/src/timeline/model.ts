import type { Issue, Layer, ProjectManifest, SeverityModel } from '@aio/schema';

/** Length assumed for a clip until its flight log tells us the real one. */
export const DEFAULT_CLIP_MS = 60_000;

export interface ClipBar {
  layerId: string;
  name: string;
  startMs: number;
  endMs: number;
  /** True while the duration is the default guess. */
  estimated: boolean;
  /** Id of the flight the clip was cut from (see `flightGroups`). */
  group: string;
  /** Project times of the clip's camera direction keyframes (none: the logged direction). */
  keys?: number[];
}

/** Clips cut from one flight log, in time order. */
export interface ClipGroup {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
  /** Video layer ids. */
  clips: string[];
}

type VideoLayer = Extract<Layer, { kind: 'video' }>;

function commonPrefix(names: readonly string[]): string {
  let p = names[0] ?? '';
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * A readable name for the clips of one flight: their common name prefix without a trailing
 * "clip" counter ("Flight 101 · Shell pass 1 · clip 1 of 7" gives "Flight 101 · Shell pass 1"),
 * else `fallback`.
 */
export function flightGroupName(names: readonly string[], fallback: string): string {
  if (names.length === 1) return names[0] ?? fallback;
  const p = commonPrefix(names)
    .replace(/(clip|part|segment|video)?\s*\d*\s*$/i, '')
    .replace(/[\s·:,|/-]+$/, '');
  return p.length >= 3 ? p : fallback;
}

const flightKey = (l: VideoLayer) =>
  `${'path' in l.flight.src ? l.flight.src.path : l.flight.src.hash}@${String(l.flight.startUtcMs)}`;

/**
 * Video layers grouped by the flight log they were cut from (same pose file and start time), in
 * manifest order. Long flights are delivered as many short clips; this keeps them together.
 */
export function flightGroups(
  layers: readonly Layer[],
): { id: string; name: string; clips: VideoLayer[] }[] {
  const groups = new Map<string, VideoLayer[]>();
  for (const l of layers) {
    if (l.kind !== 'video') continue;
    const key = flightKey(l);
    const g = groups.get(key);
    if (g) g.push(l);
    else groups.set(key, [l]);
  }
  return [...groups].map(([id, clips]) => {
    const src = clips[0]?.flight.src;
    const file = src && 'path' in src ? (src.path.split('/').pop() ?? id) : id;
    clips.sort((a, b) => a.offsetMs - b.offsetMs);
    return {
      id,
      name: flightGroupName(
        clips.map((c) => c.name),
        file.replace(/\.[^.]+$/, ''),
      ),
      clips,
    };
  });
}

export interface IssueMark {
  issueId: string;
  code: string;
  tMs: number;
  color: string | undefined;
  severity: Issue['severity'];
}

export interface PhotoMark {
  layerId: string;
  photoId: string;
  tMs: number;
}

export interface CaptureMark {
  id: string;
  label: string;
  tMs: number;
}

export interface TimelineModel {
  clips: ClipBar[];
  /** Clips by flight, in time order. */
  groups: ClipGroup[];
  issues: IssueMark[];
  photos: PhotoMark[];
  captures: CaptureMark[];
  /** Visible span in project time, or null when nothing in the project carries time. */
  range: [number, number] | null;
}

export function severityColor(
  models: readonly SeverityModel[],
  modelId: string,
  severity: Issue['severity'],
): string | undefined {
  const model = models.find((m) => m.id === modelId);
  if (!model) return undefined;
  if (severity === 'uncertain') return model.uncertain?.color;
  return model.levels.find((l) => l.value === severity)?.color;
}

/**
 * Everything the timeline draws, in project time (UTC ms). `durations` holds clip lengths in ms by
 * video layer id, read from flight logs or video metadata.
 */
export function buildTimelineModel(
  manifest: ProjectManifest,
  issues: readonly Issue[],
  durations: Readonly<Record<string, number>>,
  /** Unsaved direction keyframes of one clip (Set camera direction), shown instead of its own. */
  draft?: { layerId: string; keys: readonly { t: number }[] } | null,
): TimelineModel {
  const clips: ClipBar[] = [];
  const photos: PhotoMark[] = [];
  const groups: ClipGroup[] = [];
  for (const g of flightGroups(manifest.layers)) {
    const bars = g.clips.map((layer) => {
      const startMs = layer.flight.startUtcMs + layer.offsetMs;
      const known = durations[layer.id];
      const keys = draft?.layerId === layer.id ? draft.keys : layer.directionKeys;
      return {
        layerId: layer.id,
        name: layer.name,
        startMs,
        endMs: startMs + (known ?? DEFAULT_CLIP_MS),
        estimated: known === undefined,
        group: g.id,
        ...(keys?.length ? { keys: keys.map((k) => startMs + k.t) } : {}),
      };
    });
    clips.push(...bars);
    groups.push({
      id: g.id,
      name: g.name,
      startMs: Math.min(...bars.map((b) => b.startMs)),
      endMs: Math.max(...bars.map((b) => b.endMs)),
      clips: bars.map((b) => b.layerId),
    });
  }
  for (const layer of manifest.layers) {
    if (layer.kind === 'photos') {
      for (const item of layer.items) {
        const t = item.takenAt ? Date.parse(item.takenAt) : NaN;
        if (!Number.isNaN(t)) photos.push({ layerId: layer.id, photoId: item.id, tMs: t });
      }
    }
  }
  clips.sort((a, b) => a.startMs - b.startMs);
  groups.sort((a, b) => a.startMs - b.startMs);

  const clipStart = new Map(clips.map((c) => [c.layerId, c.startMs]));
  const photoTime = new Map(photos.map((p) => [`${p.layerId}/${p.photoId}`, p.tMs]));
  /** Time of a sighting: video track start, or the time the photo was taken. */
  const sightingTime = (s: Issue['sightings'][number]): number | undefined => {
    if (s.on === 'video') {
      const start = clipStart.get(s.layer);
      const first = s.range?.[0] ?? s.track[0]?.t;
      return start === undefined || first === undefined ? undefined : start + first;
    }
    if (s.on === 'image') return photoTime.get(`${s.layer}/${s.photo}`);
    return undefined;
  };
  const marks: IssueMark[] = [];
  for (const issue of issues) {
    const times = issue.sightings.map(sightingTime).filter((t) => t !== undefined);
    const video = issue.sightings.find((s) => s.on === 'video');
    const tMs = (video && sightingTime(video)) ?? times[0];
    if (tMs === undefined) continue;
    marks.push({
      issueId: issue.id,
      code: issue.code,
      tMs,
      color: severityColor(manifest.severityModels, issue.severityModelId, issue.severity),
      severity: issue.severity,
    });
  }

  const captures: CaptureMark[] = manifest.captures
    .map((c) => ({ id: c.id, label: c.label, tMs: Date.parse(`${c.date}T00:00:00Z`) }))
    .filter((c) => !Number.isNaN(c.tMs));

  const times = [
    ...clips.flatMap((c) => [c.startMs, c.endMs]),
    ...photos.map((p) => p.tMs),
    ...marks.map((m) => m.tMs),
  ];
  if (times.length === 0) times.push(...captures.map((c) => c.tMs));
  let range: [number, number] | null = null;
  if (times.length > 0) {
    let a = Math.min(...times);
    let b = Math.max(...times);
    if (b - a < 60_000) {
      const mid = (a + b) / 2;
      a = mid - 30_000;
      b = mid + 30_000;
    }
    const pad = (b - a) * 0.02;
    range = [a - pad, b + pad];
  }

  return { clips, groups, issues: marks, photos, captures, range };
}

export function clipAt(model: TimelineModel, tMs: number): ClipBar | undefined {
  return model.clips.find((c) => tMs >= c.startMs && tMs <= c.endMs);
}

/** The clip after (dir 1) or before (dir -1) the active one; the first clip when none is active. */
export function neighbourClip(
  model: TimelineModel,
  activeId: string | null,
  dir: 1 | -1,
): ClipBar | undefined {
  const i = model.clips.findIndex((c) => c.layerId === activeId);
  if (i < 0) return dir === 1 ? model.clips[0] : model.clips[model.clips.length - 1];
  return model.clips[i + dir];
}
