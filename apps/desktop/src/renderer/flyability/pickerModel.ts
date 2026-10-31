import type { InspectorScan, InspectorSelection } from '@aio/schema';

type Inspection = InspectorScan['inspections'][number];
type Flight = Inspection['flights'][number];

/** What is ticked: per inspection, whether it comes in and which of its flights. */
export interface Choice {
  inspections: Readonly<Record<string, { on: boolean; flights: readonly string[] }>>;
}

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
