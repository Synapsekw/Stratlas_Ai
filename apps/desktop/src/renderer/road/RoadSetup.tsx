import { lineLengthM, type MapDrawSeam, type MapLngLat, type MapOverlay } from '@aio/maps';
import { Icon, t } from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import type { FeatureCollection } from 'geojson';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { isTyping } from '../keys';
import { bridge, jobs, shell, useShell } from '../shell';
import { roadStore, setRoad, useRoad } from './store';

/** The drawn centreline file the road builder reads (main `centreline.ts`). */
export const DRAWN_CENTRELINE = 'road/centreline-drawn.geojson';

interface SetupState {
  /** Project the saved line below belongs to. */
  projectId: string | null;
  /** The centreline saved in the project, lon/lat, or null. */
  saved: MapLngLat[] | null;
  busy: boolean;
  message: string | null;
  error: string | null;
}

const setupStore = createStore<SetupState>()(() => ({
  projectId: null,
  saved: null,
  busy: false,
  message: null,
  error: null,
}));

const useSetup = <T,>(sel: (s: SetupState) => T): T => useStore(setupStore, sel);

const fmtLength = (m: number) => (m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(3)} km`);

function lineOf(json: unknown): MapLngLat[] | null {
  const f = (json as { features?: { geometry?: { type?: string; coordinates?: unknown } }[] })
    .features?.[0]?.geometry;
  if (f?.type !== 'LineString' || !Array.isArray(f.coordinates)) return null;
  return (f.coordinates as unknown[]).filter(
    (c): c is MapLngLat => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
  );
}

/** Load the centreline saved in the project (if any) when a road survey enters setup. */
function useSavedCentreline(projectId: string | null, setup: boolean): void {
  useEffect(() => {
    if (!projectId || !setup || setupStore.getState().projectId === projectId) return;
    setupStore.setState({ projectId, saved: null, message: null, error: null });
    void fetch(assetUrl(projectId, { path: DRAWN_CENTRELINE }))
      .then(async (r) => (r.ok ? lineOf(await r.json()) : null))
      .catch(() => null)
      .then((saved) => {
        if (setupStore.getState().projectId === projectId) setupStore.setState({ saved });
      });
  }, [projectId, setup]);
}

export function startDrawing(): void {
  setRoad({ draw: { on: true, vertices: [] } });
  setupStore.setState({ message: null, error: null });
  if (shell.getState().stageMode === '3d') shell.getState().setStageMode('map');
}

export function cancelDrawing(): void {
  setRoad({ draw: { on: false, vertices: [] } });
}

/** Save the drawn line in the project (`project:writeCentreline`). */
export async function finishDrawing(): Promise<void> {
  const { vertices } = roadStore.getState().draw;
  const projectId = workspace.getState().project?.id;
  if (!projectId || vertices.length < 2) return;
  setupStore.setState({ busy: true, error: null });
  const r = await bridge.call('project:writeCentreline', {
    projectId,
    coordinates: vertices.map(([lon, lat]) => [lon, lat] as [number, number]),
  });
  const res = r.ok ? r.value : { ok: false as const, error: r.error };
  if (res.ok) {
    setupStore.setState({
      busy: false,
      saved: [...vertices],
      message: t('road.setup.saved', { path: res.path }),
    });
    setRoad({ draw: { on: false, vertices: [] } });
  } else {
    setupStore.setState({ busy: false, error: res.error });
  }
}

/** Open a road survey job for the open project in the Jobs panel, the drawn line filled in. */
export function runRoadBuilder(): void {
  const root = workspace.getState().project?.root;
  if (!root) return;
  const saved = setupStore.getState().saved;
  jobs.getState().prepare({
    pipeline: 'road.build',
    project: root,
    values: saved ? { centreline: DRAWN_CENTRELINE } : {},
  });
  shell.getState().go('jobs');
}

const DRAWN_LAYERS: MapOverlay['layers'] = [
  {
    id: 'casing',
    type: 'line',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#0c121d', 'line-width': 5, 'line-opacity': 0.55 },
  },
  {
    id: 'line',
    type: 'line',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffd23f', 'line-width': 2.5, 'line-dasharray': [2, 2] },
  },
];

/**
 * The map side of road setup for the Stage: the drawing seam while drawing, and the saved
 * centreline as an overlay. Null when the open project is not a road survey in setup.
 */
export function useRoadSetupMap(): { seam: MapDrawSeam | null; overlays: MapOverlay[] } | null {
  const setup = useRoad((s) => s.status === 'setup');
  const draw = useRoad((s) => s.draw);
  const saved = useSetup((s) => s.saved);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  useSavedCentreline(projectId, setup);

  // keys while drawing: Enter finishes, Backspace drops the last point, Escape stops
  useEffect(() => {
    if (!setup || !draw.on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      const d = roadStore.getState().draw;
      if (e.key === 'Enter') void finishDrawing();
      else if (e.key === 'Backspace')
        setRoad({ draw: { ...d, vertices: d.vertices.slice(0, -1) } });
      else if (e.key === 'Escape') cancelDrawing();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [setup, draw.on]);

  const seam = useMemo<MapDrawSeam | null>(
    () =>
      draw.on
        ? {
            mode: 'line',
            vertices: draw.vertices,
            onClick: (at) => {
              const d = roadStore.getState().draw;
              setRoad({ draw: { ...d, vertices: [...d.vertices, at] } });
            },
            onFinish: () => void finishDrawing(),
          }
        : null,
    [draw],
  );
  const overlays = useMemo<MapOverlay[]>(() => {
    if (!saved || saved.length < 2 || draw.on) return [];
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: saved.map((p) => [...p]) },
        },
      ],
    };
    return [{ id: 'road-drawn', data, layers: DRAWN_LAYERS }];
  }, [saved, draw.on]);
  if (!setup) return null;
  return { seam, overlays };
}

/** Right panel card of a road survey whose road builder has not run: draw, save, run. */
export function RoadSetupCard() {
  const setup = useRoad((s) => s.status === 'setup');
  const draw = useRoad((s) => s.draw);
  const mode = useShell((s) => s.stageMode);
  const saved = useSetup((s) => s.saved);
  const busy = useSetup((s) => s.busy);
  const message = useSetup((s) => s.message);
  const error = useSetup((s) => s.error);
  if (!setup) return null;
  const n = draw.vertices.length;
  return (
    <section className="rr-setup" aria-label={t('road.setup.title')} data-testid="road-setup">
      <h3>
        <Icon name="road" size={14} />
        {t('road.setup.title')}
      </h3>
      <p className="muted small">{t('road.setup.text')}</p>
      {draw.on ? (
        <>
          <p className="small">
            {mode === '3d' ? t('road.setup.mapOnly') : t('road.setup.drawing')}
          </p>
          <p className="mono small" data-testid="road-setup-count">
            {t('road.setup.points', { count: n, length: fmtLength(lineLengthM(draw.vertices)) })}
          </p>
          <div className="rr-setup-acts">
            <button
              type="button"
              className="btn sm primary"
              disabled={n < 2 || busy}
              onClick={() => void finishDrawing()}
            >
              {t('road.setup.finish')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={n === 0}
              onClick={() => {
                setRoad({ draw: { on: true, vertices: [] } });
              }}
            >
              {t('road.setup.clear')}
            </button>
            <button type="button" className="btn sm ghost" onClick={cancelDrawing}>
              {t('road.setup.cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="rr-setup-acts">
          <button type="button" className="btn sm" onClick={startDrawing}>
            <Icon name="ruler" size={14} />
            {t('road.setup.draw')}
          </button>
          <button
            type="button"
            className={`btn sm${saved ? ' primary' : ''}`}
            title={t('road.setup.runHelp')}
            onClick={runRoadBuilder}
          >
            <Icon name="play" size={14} />
            {t('road.setup.run')}
          </button>
        </div>
      )}
      {message && <p className="small ok">{message}</p>}
      {error && (
        <p className="small bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
