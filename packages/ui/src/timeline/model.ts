import type { Issue, ProjectManifest, SeverityModel } from '@aio/schema';

/** Length assumed for a clip until its flight log tells us the real one. */
export const DEFAULT_CLIP_MS = 60_000;

export interface ClipBar {
  layerId: string;
  name: string;
  startMs: number;
  endMs: number;
  /** True while the duration is the default guess. */
  estimated: boolean;
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
): TimelineModel {
  const clips: ClipBar[] = [];
  const photos: PhotoMark[] = [];
  for (const layer of manifest.layers) {
    if (layer.kind === 'video') {
      const startMs = layer.flight.startUtcMs + layer.offsetMs;
      const known = durations[layer.id];
      clips.push({
        layerId: layer.id,
        name: layer.name,
        startMs,
        endMs: startMs + (known ?? DEFAULT_CLIP_MS),
        estimated: known === undefined,
      });
    } else if (layer.kind === 'photos') {
      for (const item of layer.items) {
        const t = item.takenAt ? Date.parse(item.takenAt) : NaN;
        if (!Number.isNaN(t)) photos.push({ layerId: layer.id, photoId: item.id, tMs: t });
      }
    }
  }
  clips.sort((a, b) => a.startMs - b.startMs);

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

  return { clips, issues: marks, photos, captures, range };
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
