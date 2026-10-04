import type { Layer } from '@aio/schema';
import { flightGroups } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import {
  defaultPathPref,
  flightPaths,
  useFlightPaths,
  type FlightRef,
  type PathPref,
} from './flightPaths';

export interface FlightPathModel {
  projectId: string;
  flights: FlightRef[];
  pref: PathPref;
  /** The flight holding the active clip. */
  activeFlight: string | null;
}

/** The project's flights (clips cut from one flight log share a path). */
export function flightRefs(layers: readonly Layer[]): FlightRef[] {
  return flightGroups(layers).map((f) => ({ id: f.id, clips: f.clips.map((c) => c.id) }));
}

export function activeFlightOf(flights: readonly FlightRef[], clip: string | null): string | null {
  if (!clip) return null;
  return flights.find((f) => f.clips.includes(clip))?.id ?? null;
}

const clipCount = (flights: readonly FlightRef[]) =>
  flights.reduce((n, f) => n + f.clips.length, 0);

/** Flight paths of the open project, for the toolbar, the sidebar and the stage. */
export function useFlightPathModel(): FlightPathModel | null {
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const saved = useFlightPaths((s) => (project ? s.byProject[project.id] : undefined));
  const flights = useMemo(() => (project ? flightRefs(project.manifest.layers) : []), [project]);
  const pref = useMemo(() => saved ?? defaultPathPref(clipCount(flights)), [saved, flights]);
  if (!project || flights.length === 0) return null;
  return {
    projectId: project.id,
    flights,
    pref,
    activeFlight: activeFlightOf(flights, activeClip),
  };
}

/** The same model outside React (shortcuts, the command palette). */
export function flightPathModel(): FlightPathModel | null {
  const ws = workspace.getState();
  if (!ws.project) return null;
  const flights = flightRefs(ws.project.manifest.layers);
  if (flights.length === 0) return null;
  return {
    projectId: ws.project.id,
    flights,
    pref: flightPaths.getState().pref(ws.project.id, clipCount(flights)),
    activeFlight: activeFlightOf(flights, ws.activeClip),
  };
}

/** Change the open project's flight path choice. */
export function updateFlightPaths(fn: (p: PathPref, m: FlightPathModel) => PathPref): void {
  const m = flightPathModel();
  if (m) flightPaths.getState().set(m.projectId, fn(m.pref, m));
}
