/**
 * The comparisons of a polygon measurement (M11 G4, PRD SRV-1 and SRV-2), now the volume card's
 * detail (`card/VolumeDetail.tsx`: plain bases, one status line, the spread, a carried figure and
 * the volume over time), with the heat map of the difference under it; and the comparisons' mount
 * in the measurements layer (`CompareLayer`).
 */
import type { EngineStage } from '@aio/engine';
import type { MapController } from '@aio/maps';
import type { SurveyMeasurement } from '@aio/schema';
import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { VolumeDetail } from './card/VolumeDetail';
import {
  followMeasurements,
  loadCompare,
  setHeat,
  useCompare,
  type Computed,
} from './compareStore';
import { attachHeat3d, attachHeatMap, attachSiteMap } from './heatScene';
import { HeatmapStopsButton } from './HeatmapStops';
import { Materials } from './Materials';
import type { Frame } from './measureScene';
import { WholeSite } from './WholeSite';
import './compare.css';

/** The comparisons section of a polygon measurement's panel. */
export function Comparisons({ m }: { m: SurveyMeasurement }) {
  const t = useT();
  const computed = useCompare((s) => s.computed[m.id]);
  if (m.family !== 'polygon') return null;
  return (
    <details className="sv-sec" open data-testid="survey-comparisons">
      <summary>{t('vol.card.comparisons', { n: m.items.length })}</summary>
      <VolumeDetail m={m} />
      {m.items.length > 0 && <HeatControls m={m} computed={computed ?? null} />}
    </details>
  );
}

function HeatControls({ m, computed }: { m: SurveyMeasurement; computed: Computed | null }) {
  const t = useT();
  const heat = useCompare((s) => s.heat);
  const has = (computed?.heat.length ?? 0) > 0;
  return (
    <fieldset className="sv-sub" data-testid="survey-heat">
      <legend>{t('heat.panel.title')}</legend>
      <div className="sv-row sv-wrap">
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.show3d}
            onChange={(e) => {
              setHeat({ show3d: e.target.checked });
            }}
          />
          {t('heat.panel.on3d')}
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.show2d}
            onChange={(e) => {
              setHeat({ show2d: e.target.checked });
            }}
          />
          {t('heat.panel.on2d')}
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={heat.contours}
            onChange={(e) => {
              setHeat({ contours: e.target.checked });
            }}
          />
          {t('heat.panel.contours')}
        </label>
      </div>
      {m.items.length > 1 && (
        <label className="sv-field">
          <span>{t('heat.panel.show')}</span>
          <select
            className="sv-input"
            value={heat.item ?? m.items[0]?.id ?? ''}
            onChange={(e) => {
              setHeat({ item: e.target.value });
            }}
          >
            {m.items.map((it, k) => (
              <option key={it.id} value={it.id}>
                {it.label ?? t('vol.card.comparisonN', { n: k + 1 })}
              </option>
            ))}
          </select>
        </label>
      )}
      {!has && <p className="small faint">{t('heat.panel.none')}</p>}
      <HeatmapStopsButton />
    </fieldset>
  );
}

/**
 * The comparisons' mount in the measurements layer: the engine for the open project, the focused
 * polygon followed, its heat maps in the 3D view and on the map, and the G4 dialogs.
 */
export function CompareLayer({
  stage,
  map,
  frame,
}: {
  stage: EngineStage | null;
  map: MapController | null;
  frame: Frame | null;
}) {
  const project = useWorkspace((s) => s.project);
  const dialog = useCompare((s) => s.dialog);
  const projectId = project?.id ?? null;
  useEffect(() => followMeasurements(), []);
  useEffect(() => {
    void loadCompare(
      project ? { id: project.id, root: project.root, manifest: project.manifest } : null,
    );
    // the project's identity, not each manifest edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => (stage && frame ? attachHeat3d(stage, frame) : undefined), [stage, frame]);
  useEffect(() => (map && frame ? attachHeatMap(map, frame) : undefined), [map, frame]);
  useEffect(
    () => (map && frame && projectId ? attachSiteMap(map, frame, projectId) : undefined),
    [map, frame, projectId],
  );
  return (
    <>
      {dialog === 'materials' && <Materials />}
      {dialog === 'site' && <WholeSite />}
    </>
  );
}
