/**
 * Small helpers of the survey QA and cleanup panels (M11 G8): the survey in focus, terrain edits
 * from measurement rings and survey extents.
 */
import type { HeightTiles, SitePoint2, SurveyMeasurement, TerrainEdit } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useTimeline } from '../workspace/timeline';
import { newEditId } from './qaStore';

/** The survey in focus (the date bar's), else the latest survey of the project. */
export function useFocusCapture(): string | null {
  const focus = useTimeline((s) => s.focus);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  if (focus) return focus;
  const last = [...(captures ?? [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return last?.id ?? null;
}

/** A polygon measurement's ring (E, N). */
export const ringOf = (m: SurveyMeasurement): SitePoint2[] => m.points.map((p) => [p[0], p[1]]);

/** The rectangle a prepared surface has data in (E, N). */
export function extentRing(s: Pick<HeightTiles, 'bounds'>): SitePoint2[] {
  const [e0, n0, , e1, n1] = s.bounds;
  return [
    [e0, n0],
    [e1, n0],
    [e1, n1],
    [e0, n1],
  ];
}

/** A new terrain edit of `surface` from a ring. */
export function editFrom(
  kind: TerrainEdit['kind'],
  surface: string,
  ring: SitePoint2[],
  label: string,
  method?: 'tin' | 'thin-plate',
): TerrainEdit {
  return {
    id: newEditId(kind),
    kind,
    surface,
    ring,
    ...(kind === 'cleanup' ? { method: method ?? 'tin' } : {}),
    enabled: true,
    label: label.slice(0, 200),
    createdAt: new Date().toISOString(),
  };
}
