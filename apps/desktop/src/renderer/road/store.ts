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
  status: 'none' | 'loading' | 'ready' | 'error';
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

/**
 * Follow the open project: load `road.json` for a road survey (data-conventions section 8) and
 * keep the defect rows in step with the issues. Returns an unsubscribe function.
 */
export function startRoadSync(
  store = workspace,
  load: (url: string) => Promise<unknown> = async (url) => (await fetch(url)).json(),
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
    roadStore.setState({ ...initial, projectId: project.id, status: 'loading' });
    void load(assetUrl(project.id, { path: 'road.json' }))
      .then((json) => {
        if (mine !== seq) return;
        const r = parseRoadModel(json);
        if (!r.ok) {
          roadStore.setState({ status: 'error', error: r.error });
          return;
        }
        roadStore.setState({
          status: 'ready',
          road: r.value,
          rows: rowsFor(store.getState(), r.value),
        });
      })
      .catch((e: unknown) => {
        if (mine !== seq) return;
        roadStore.setState({
          status: 'error',
          error: `Road model not loaded: ${e instanceof Error ? e.message : String(e)}`,
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
