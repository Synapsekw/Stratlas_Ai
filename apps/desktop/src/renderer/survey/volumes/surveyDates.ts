/**
 * The project's survey dates as `densityOn` reads them (volumetrics redesign, Stage C): a capture
 * id to its date, from the manifest's captures. Pure, so every reader of a dated density (the
 * pile panel, the volume card, the 3D callouts, the Materials pane) shares it without a store.
 */
import type { SiteMaterial } from '@aio/schema';
import { densityOn, type CaptureDateOf, type TimeRow } from '@aio/survey';

/** A capture and its ISO date ('' or absent: no date). */
export interface DatedCapture {
  id: string;
  date?: string;
}

/** A capture's date as milliseconds, null for an undated or unknown capture. */
export function captureDateOf(captures: readonly DatedCapture[]): CaptureDateOf {
  const at = new Map<string, number>();
  for (const c of captures) {
    if (!c.date) continue;
    const t = Date.parse(c.date.slice(0, 10));
    if (Number.isFinite(t)) at.set(c.id, t);
  }
  return (capture) => at.get(capture) ?? null;
}

/** The dated captures, oldest first (undated ones left out). */
export function datedCaptures(captures: readonly DatedCapture[]): DatedCapture[] {
  const dateOf = captureDateOf(captures);
  return captures
    .filter((c) => dateOf(c.id) !== null)
    .sort((a, b) => (dateOf(a.id) ?? 0) - (dateOf(b.id) ?? 0));
}

/**
 * Rows over time weighed date by date: each row's tonnes at the material's density on its own
 * date (`densityOn`), so a density edited from a later date leaves the earlier dates' tonnes as
 * they were. No material, or no density on a date: no tonnes there.
 */
export function weighRows<R extends Pick<TimeRow, 'capture' | 'valueM3' | 'tonnes'>>(
  rows: readonly R[],
  material: SiteMaterial | null | undefined,
  dateOf: CaptureDateOf,
): R[] {
  return rows.map((r) => {
    const d = material ? densityOn(material, r.capture, dateOf) : null;
    return { ...r, tonnes: r.valueM3 !== null && d !== null ? r.valueM3 * d : null };
  });
}
