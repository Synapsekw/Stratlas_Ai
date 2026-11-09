import type { InspectorMission, InspectorScan, InspectorSelection } from '@aio/schema';

type Inspection = InspectorScan['inspections'][number];
type Flight = Inspection['flights'][number];

/** What is ticked: per inspection, whether it comes in and which of its flights. */
export interface Choice {
  inspections: Readonly<Record<string, { on: boolean; flights: readonly string[] }>>;
}

/** The longest space name a selection may carry (`InspectorSelection` `space`). */
export const SPACE_NAME_MAX = 200;

/** A flight with neither a cloud nor a path has nothing to bring in. */
export const importable = (f: Flight): boolean => f.cloud || f.path;

const importableIds = (i: Inspection): string[] => i.flights.filter(importable).map((f) => f.id);

/** New inspections ticked with every flight that has data; imported ones unticked (and marked). */
export function initialChoice(scan: InspectorScan): Choice {
  const out: Record<string, { on: boolean; flights: readonly string[] }> = {};
  for (const i of scan.inspections) {
    const fresh = i.importedAs === null;
    out[i.id] = { on: fresh, flights: fresh ? importableIds(i) : [] };
  }
  return { inspections: out };
}

/** The whole inspection on (every flight with data) or off. */
export function toggleInspection(choice: Choice, scan: InspectorScan, id: string): Choice {
  const i = scan.inspections.find((x) => x.id === id);
  const cur = choice.inspections[id];
  if (!i || !cur) return choice;
  const all = importableIds(i);
  const full = cur.on && all.every((f) => cur.flights.includes(f));
  const next = full ? { on: false, flights: [] } : { on: true, flights: all };
  return { inspections: { ...choice.inspections, [id]: next } };
}

/** One flight; the last flight unticked unticks the inspection, a flight ticked ticks it. */
export function toggleFlight(
  choice: Choice,
  scan: InspectorScan,
  inspectionId: string,
  flightId: string,
): Choice {
  const i = scan.inspections.find((x) => x.id === inspectionId);
  const cur = choice.inspections[inspectionId];
  const f = i?.flights.find((x) => x.id === flightId);
  if (!i || !cur || !f || !importable(f)) return choice;
  const flights = cur.flights.includes(flightId)
    ? cur.flights.filter((x) => x !== flightId)
    : [...cur.flights, flightId];
  const next = { on: flights.length > 0, flights };
  return { inspections: { ...choice.inspections, [inspectionId]: next } };
}

/** The request for `builder:import`; null when nothing is ticked. `flights` is left out for all. */
export function selectionOf(choice: Choice, scan: InspectorScan): InspectorSelection | null {
  const picked: InspectorSelection['inspections'] = [];
  for (const i of scan.inspections) {
    const c = choice.inspections[i.id];
    if (!c?.on) continue;
    const all = importableIds(i);
    const flights = all.filter((f) => c.flights.includes(f));
    // an inspection with flights but none ticked has nothing to bring in
    if (all.length > 0 && flights.length === 0) continue;
    picked.push(flights.length === all.length ? { id: i.id } : { id: i.id, flights });
  }
  return picked.length === 0 ? null : { inspections: picked };
}

/**
 * Every chamber's inspections as one scan, for the per-inspection ticks (inspection ids are
 * unique across exports; a repeat of one already listed is left out).
 */
export function flatScan(mission: InspectorMission): InspectorScan {
  const seen = new Set<string>();
  const inspections: Inspection[] = [];
  for (const e of mission.exports)
    for (const i of e.scan.inspections) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      inspections.push(i);
    }
  return {
    root: mission.root,
    generation: mission.exports[0]?.scan.generation ?? 'unknown',
    asset: mission.exports.length === 1 ? (mission.exports[0]?.scan.asset ?? null) : null,
    inspections,
  };
}

/** The picked folder as a mission of one export (a picker opened on a bare scan). */
export function missionOfScan(path: string, scan: InspectorScan): InspectorMission {
  return {
    root: path,
    exports: [{ path, name: scan.asset ?? path, scan }],
    skipped: { folders: [], files: 0 },
    capped: false,
  };
}

/** Whether all, some or none of a chamber's inspections come in. */
export function chamberTick(choice: Choice, scan: InspectorScan): 'all' | 'some' | 'none' {
  const picked = selectionOf(choice, scan)?.inspections ?? [];
  if (picked.length === 0) return 'none';
  const full = scan.inspections.every((i) => {
    const c = choice.inspections[i.id];
    return c?.on === true && importableIds(i).every((f) => c.flights.includes(f));
  });
  return full ? 'all' : 'some';
}

/** The whole chamber on (every inspection with every flight that has data) or off. */
export function toggleChamber(choice: Choice, scan: InspectorScan): Choice {
  const on = chamberTick(choice, scan) !== 'all';
  const next = { ...choice.inspections };
  for (const i of scan.inspections)
    next[i.id] = on ? { on: true, flights: importableIds(i) } : { on: false, flights: [] };
  return { inspections: next };
}

/** Chambers, finding photos and point clouds (flight clouds and merged models) in the mission. */
export function missionTotals(mission: InspectorMission): {
  chambers: number;
  photos: number;
  clouds: number;
} {
  let photos = 0;
  let clouds = 0;
  for (const e of mission.exports)
    for (const i of e.scan.inspections) {
      photos += i.photos;
      clouds += i.flights.filter((f) => f.cloud).length + (i.mergedCloud ? 1 : 0);
    }
  return { chambers: mission.exports.length, photos, clouds };
}

/**
 * The import request: the ticked chambers' folders and their inspections. A chamber found below
 * the picked folder that holds one inspection not yet imported names its new space after the
 * chamber folder (an inspection's own name is often only a date). Null when nothing is ticked.
 */
export function missionRequest(
  choice: Choice,
  mission: InspectorMission,
): { paths: string[]; inspector: InspectorSelection } | null {
  const paths: string[] = [];
  const picked: InspectorSelection['inspections'] = [];
  const taken = new Set<string>();
  for (const e of mission.exports) {
    const sel = selectionOf(choice, e.scan);
    if (!sel) continue;
    const own = e.path === mission.root;
    const sole = e.scan.inspections.length === 1 ? e.scan.inspections[0] : undefined;
    const fresh = sel.inspections.filter((i) => !taken.has(i.id));
    if (fresh.length === 0) continue;
    paths.push(e.path);
    for (const i of fresh) {
      taken.add(i.id);
      const named = !own && sole?.id === i.id && sole.importedAs === null;
      picked.push(named ? { ...i, space: e.name.slice(0, SPACE_NAME_MAX).trim() } : i);
    }
  }
  return picked.length === 0 ? null : { paths, inspector: { inspections: picked } };
}
