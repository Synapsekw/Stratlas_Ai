import { frameProjection, type MapLngLat } from '@aio/maps';
import { parseRoadModel, type PciSeverity, type RoadModel } from '@aio/schema';
import { assetUrl, workspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import {
  defectRows,
  isRoadProject,
  NO_FILTER,
  type DefectFilter,
  type DefectRow,
  type DefectSort,
  type DensityMeasure,
} from './model';
import type { AreaOverlay } from './overlays';

export type MeasureMode = 'line' | 'polygon';

export interface RoadState {
  /** Project the road model belongs to. */
  projectId: string | null;
  /** `setup`: a road survey without road.json yet (the road builder has not run). */
  status: 'none' | 'loading' | 'ready' | 'error' | 'setup';
  /** Drawing the centreline on the map (setup), its vertices in lon/lat. */
  draw: { on: boolean; vertices: MapLngLat[] };
  error: string | null;
  road: RoadModel | null;
  /** Every defect (issue with a map sighting), with chainage. */
  rows: DefectRow[];
  centreline: boolean;
  overlay: AreaOverlay;
  pciSeverity: PciSeverity;
  densitySize: string;
  densityMeasure: DensityMeasure;
  opacity: number;
  colorBy: 'severity' | 'class';
  filter: DefectFilter;
  sort: DefectSort;
  measure: { mode: MeasureMode | null; vertices: MapLngLat[] };
  /** The close-up of the selected defect is docked beside the map. */
  closeup: boolean;
  /** PCI sample unit whose deducts are shown (clicked on the map). */
  pciUnit: string | null;
}

const initial: RoadState = {
  projectId: null,
  status: 'none',
  draw: { on: false, vertices: [] },
  error: null,
  road: null,
  rows: [],
  centreline: true,
  overlay: 'none',
  pciSeverity: 'medium',
  densitySize: '20',
  densityMeasure: 'count',
  opacity: 0.7,
  colorBy: 'severity',
  filter: NO_FILTER,
  sort: 'severity',
  measure: { mode: null, vertices: [] },
  closeup: true,
  pciUnit: null,
};

/** Road workspace state: the road model, layer toggles, defect filters and the map measure. */
export const roadStore = createStore<RoadState>()(() => initial);

export function useRoad<T>(selector: (s: RoadState) => T): T {
  return useStore(roadStore, selector);
}

export function setRoad(patch: Partial<RoadState>): void {
  roadStore.setState(patch);
}

export function setFilter(patch: Partial<DefectFilter>): void {
  roadStore.setState((s) => ({ filter: { ...s.filter, ...patch } }));
}

function rowsFor(ws: Workspace, road: RoadModel): DefectRow[] {
  const project = ws.project;
  if (!project) return [];
  const proj = frameProjection(project.manifest.crs, project.manifest.origin);
  if (!proj) return [];
  return defectRows(ws.issues, project.manifest, road, (lon, lat) => {
    const p = proj.toLocal(lon, lat);
    return [p[0], p[2]];
  });
}

/** `road.json` of the project, or null when it has none (404). */
async function fetchRoad(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  return res.json();
}

/**
 * Follow the open project: load `road.json` for a road survey (data-conventions section 9) and
 * keep the defect rows in step with the issues. A road survey without road.json (the road
 * builder has not run yet) is in `setup`. Returns an unsubscribe function.
 *
 * The open project is replaced by a newer copy of itself whenever its records are read again: a
 * job ended, a sync merged, a layer was saved (and the road builder's end does it twice, once
 * for the job and once for the journal). That is not another project: `road.json` is read again,
 * and the view stays as the person set it (overlay, filters, sort, a centreline being drawn),
 * with the road shown until the new one is in.
 */
export function startRoadSync(
  store = workspace,
  load: (url: string) => Promise<unknown> = fetchRoad,
): () => void {
  let seq = 0;
  const open = (ws: Workspace) => {
    const project = ws.project;
    seq += 1;
    const mine = seq;
    if (!project || !isRoadProject(project.manifest)) {
      roadStore.setState({ ...initial });
      return;
    }
    const again = roadStore.getState().projectId === project.id;
    if (!again) roadStore.setState({ ...initial, projectId: project.id, status: 'loading' });
    void load(assetUrl(project.id, { path: 'road.json' }))
      .then((json) => {
        if (mine !== seq) return;
        if (json === null) {
          roadStore.setState({ status: 'setup', error: null, road: null, rows: [] });
          return;
        }
        const r = parseRoadModel(json);
        if (!r.ok) {
          roadStore.setState({ status: 'error', error: r.error, road: null, rows: [] });
          return;
        }
        roadStore.setState({
          status: 'ready',
          error: null,
          road: r.value,
          rows: rowsFor(store.getState(), r.value),
          // the centreline is drawn only until the road builder has run
          draw: initial.draw,
        });
      })
      .catch((e: unknown) => {
        if (mine !== seq) return;
        roadStore.setState({
          status: 'error',
          error: `Road model not loaded: ${e instanceof Error ? e.message : String(e)}`,
          road: null,
          rows: [],
        });
      });
  };
  open(store.getState());
  return store.subscribe((s, prev) => {
    if (s.project !== prev.project) open(s);
    else if (s.issues !== prev.issues) {
      const road = roadStore.getState().road;
      if (road) roadStore.setState({ rows: rowsFor(s, road) });
    }
  });
}
