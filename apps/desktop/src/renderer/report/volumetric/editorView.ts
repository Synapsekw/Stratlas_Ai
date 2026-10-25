// Where the volumetric report editor stands across screens: taking the pictures opens the Scene
// and comes back, which unmounts the Reports screen, so whether the editor is open, how many times
// pictures were taken (a new count fetches the model again) and the last picture error live here.
// Also the fingerprints: of what the pictures show (saved with them, to tell when they are stale)
// and of the figures (a new one asks main for the model again).
import type { SurveyMeasurement } from '@aio/schema';
import { createStore } from 'zustand/vanilla';
import { stockpileItem } from '../../reportPage/house/surveyData';

export interface VolumetricViewState {
  /** The project whose volumetric report editor is open, else null. */
  openFor: string | null;
  /** Pictures taken this session, by project. */
  taken: Record<string, number>;
  /** Why the last Take pictures failed, else null. */
  pictureError: string | null;
}

export const volumetricView = createStore<VolumetricViewState>()(() => ({
  openFor: null,
  taken: {},
  pictureError: null,
}));

export function openVolumetricEditor(projectId: string): void {
  volumetricView.setState({ openFor: projectId, pictureError: null });
}

export function closeVolumetricEditor(): void {
  volumetricView.setState({ openFor: null, pictureError: null });
}

/** A new set of pictures was saved for the project. */
export function picturesTaken(projectId: string): void {
  const taken = volumetricView.getState().taken;
  volumetricView.setState({ taken: { ...taken, [projectId]: (taken[projectId] ?? 0) + 1 } });
}

/** The measurements the report is about: the stockpiles (a base to a survey). */
export function reportPiles(measurements: readonly SurveyMeasurement[]): SurveyMeasurement[] {
  return measurements.filter((m) => stockpileItem(m) !== null);
}

/** FNV-1a, 32 bit, twice with different seeds: 16 hex characters. */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 2);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(a)}${hex(b)}`;
}

/** What the pictures show: the piles' outlines, the dates and the compared pair. */
export function picturesFingerprint(
  measurements: readonly SurveyMeasurement[],
  dates: readonly string[],
  pair: { from: string; to: string } | null,
): string {
  const piles = reportPiles(measurements)
    .map((m) => ({ id: m.id, points: m.points, outlines: m.outlines ?? null }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return `v1-${String(piles.length)}-${hash(JSON.stringify({ piles, dates, pair }))}`;
}

/** The figures the report prints from: any edit of a stockpile measurement changes it. */
export function figuresKey(measurements: readonly SurveyMeasurement[]): string {
  return hash(JSON.stringify(reportPiles(measurements)));
}
