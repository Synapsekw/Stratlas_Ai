/**
 * Site materials (M11 G4, PRD SRV-6, data-conventions section 27): name, ID, code, density and
 * swell factors, kept in `survey/settings.json` (`materials`, at most 500). They are edited in the
 * Volumes tab's Materials pane (volumetrics redesign, board 5); the old dialog is retired.
 *
 * Here: CSV import and export for that pane, and `Materials`, which stands in for the dialog so
 * anything still asking for it opens the pane instead.
 */
import type { SiteMaterial } from '@aio/schema';
import { materialsToCsv } from '@aio/survey';
import { useEffect } from 'react';
import { bridge } from '../shell';
import { openCompareDialog } from './compareStore';
import { materialsDraft, openMaterialsPane } from './volumes/materialsDraft';

/** What an import or export says: a note, an error, or both. */
export interface CsvOutcome {
  note: string | null;
  error: string | null;
}

/** Read a CSV file into the materials draft (merged by id). */
export async function importMaterialsCsv(
  f: Pick<File, 'name' | 'text'>,
  draft = materialsDraft,
): Promise<CsvOutcome> {
  const text = await f.text();
  const got = draft.getState().importCsv(text);
  const left = got.problems.length;
  return {
    note: `${String(got.read)} materials read from ${f.name}${left ? `, ${String(left)} rows left out` : ''}. Save to keep them.`,
    error: left ? got.problems.slice(0, 5).join(' ') : null,
  };
}

/** Save the materials as a CSV file (the columns of `materialsToCsv`). */
export async function exportMaterialsCsv(
  materials: readonly SiteMaterial[],
  call: typeof bridge.call = bridge.call.bind(bridge),
): Promise<CsvOutcome> {
  const res = await call('dialog:saveFile', {
    defaultName: 'site-materials.csv',
    data: materialsToCsv(materials),
    title: 'Export the site materials',
  });
  if (!res.ok) return { note: null, error: res.error };
  if (res.value.error) return { note: null, error: res.value.error };
  return { note: res.value.path ? `Exported to ${res.value.path}.` : null, error: null };
}

/** The retired dialog: closes itself and opens the Materials pane. */
export function Materials(): null {
  useEffect(() => {
    openCompareDialog(null);
    openMaterialsPane();
  }, []);
  return null;
}
