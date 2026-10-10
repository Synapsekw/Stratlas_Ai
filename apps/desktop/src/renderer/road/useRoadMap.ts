import {
  frameProjection,
  lineLengthM,
  polygonAreaM2,
  type MapDrawSeam,
  type MapLngLat,
  type MapOverlay,
} from '@aio/maps';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { filterDefects, pointAtKm, sortDefects, type DefectRow } from './model';
import { densityCollection, roadOverlays } from './overlays';
import { roadStore, setRoad, useRoad, type MeasureMode, type RoadState } from './store';

/** True while the open project is a road survey with its road model loaded. */
export function useIsRoad(): boolean {
  return useRoad((s) => s.status === 'ready');
}

/** The defects that pass the filters, in the chosen order. */
export function filteredDefects(s: Pick<RoadState, 'rows' | 'filter' | 'sort'>): DefectRow[] {
  return sortDefects(filterDefects(s.rows, s.filter), s.sort);
}

/** `filteredDefects` of the store (memoised on the store values). */
export function useFilteredDefects(): DefectRow[] {
  const rows = useRoad((s) => s.rows);
  const filter = useRoad((s) => s.filter);
  const sort = useRoad((s) => s.sort);
  return useMemo(() => filteredDefects({ rows, filter, sort }), [rows, filter, sort]);
}

export interface RoadMapProps {
  overlays: MapOverlay[];
  issueFilter: ReadonlySet<string> | null;
  issueColorBy: 'severity' | 'class';
  /** The map measure, when it is on (it takes the map clicks). */
  measure: MapDrawSeam | null;
}

/** MapView props for the road workspace: overlays, the filtered defects and the measure. */
export function useRoadMap(): RoadMapProps | null {
  const ready = useIsRoad();
  const road = useRoad((s) => s.road);
  const project = useWorkspace((s) => s.project);
  const centreline = useRoad((s) => s.centreline);
  const overlay = useRoad((s) => s.overlay);
  const pciSeverity = useRoad((s) => s.pciSeverity);
  const densitySize = useRoad((s) => s.densitySize);
  const densityMeasure = useRoad((s) => s.densityMeasure);
  const opacity = useRoad((s) => s.opacity);
  const colorBy = useRoad((s) => s.colorBy);
  const rows = useRoad((s) => s.rows);
  const filter = useRoad((s) => s.filter);
  const measure = useRoad((s) => s.measure);
  const proj = useMemo(
    () => (project ? frameProjection(project.manifest.crs, project.manifest.origin) : null),
    [project],
  );

  // Density cells are built only once that overlay has been shown, per size and measure.
  const density = useMemo(
    () =>
      road && proj && overlay === 'density'
        ? densityCollection(road, densitySize, densityMeasure, (p) => proj.toLonLat(p))
        : null,
    [road, proj, overlay, densitySize, densityMeasure],
  );

  const overlays = useMemo(() => {
    if (!road || !proj || !project) return [];
    return roadOverlays(
      road,
      { centreline, overlay, pciSeverity, densitySize, densityMeasure, opacity },
      {
        url: (path) => assetUrl(project.id, { path }),
        toLonLat: (p) => proj.toLonLat(p),
        density,
        onPciUnit: (p) => {
          if (typeof p.id === 'string') setRoad({ pciUnit: p.id });
        },
      },
    );
  }, [
    road,
    proj,
    project,
    centreline,
    overlay,
    pciSeverity,
    densitySize,
    densityMeasure,
    opacity,
    density,
  ]);

  const issueFilter = useMemo(() => {
    const f = filter;
    if (!f.severities && !f.classes && !f.kmRange && !f.search.trim()) return null;
    return new Set(filterDefects(rows, f).map((r) => r.id));
  }, [rows, filter]);

  const seam = useMemo<MapDrawSeam | null>(
    () =>
      measure.mode
        ? {
            mode: measure.mode,
            vertices: measure.vertices,
            onClick: (at: MapLngLat) => {
              const m = roadStore.getState().measure;
              setRoad({ measure: { ...m, vertices: [...m.vertices, at] } });
            },
            onFinish: () => undefined,
          }
        : null,
    [measure],
  );

  if (!ready) return null;
  return { overlays, issueFilter, issueColorBy: colorBy, measure: seam };
}

/** Length (line) or area (polygon) of the current measure, formatted; null with too few points. */
export function measureText(mode: MeasureMode, vertices: readonly MapLngLat[]): string | null {
  if (mode === 'line') {
    if (vertices.length < 2) return null;
    const m = lineLengthM(vertices);
    return m < 1000 ? `${m.toFixed(2)} m` : `${(m / 1000).toFixed(3)} km`;
  }
  if (vertices.length < 3) return null;
  const a = polygonAreaM2(vertices);
  return a < 100 ? `${a.toFixed(2)} m²` : `${Math.round(a).toLocaleString('en-GB')} m²`;
}

/** Move the map and the 3D view to a chainage on the centreline. */
export function jumpToKm(km: number, distanceM = 160): void {
  const road = roadStore.getState().road;
  if (!road) return;
  workspace.getState().flyTo({ kind: 'point', p: pointAtKm(road, km), distance: distanceM });
}

/** Select a defect and frame it on the map and in 3D, with room around small ones. */
export function focusDefect(row: DefectRow): void {
  const ws = workspace.getState();
  ws.select({ kind: 'issue', id: row.id });
  ws.flyTo({
    kind: 'point',
    p: [row.at[0], 0, row.at[1]],
    distance: Math.max(14, (row.extentM ?? 8) * 1.6),
  });
}
