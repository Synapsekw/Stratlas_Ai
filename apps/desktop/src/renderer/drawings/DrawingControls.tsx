import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { shell } from '../shell';
import { DEFAULT_SPLIT } from '../workspace/splitModel';
import { stagePrefs, useStagePrefs } from '../workspace/stagePrefs';
import { DEFAULT_OPACITY, withDrawingDisplay } from './display';
import { sideBySide } from './model';
import { drawings, useDrawings } from './store';

/** Show a drawing beside the 3D view or the map: the split, with the drawing on the right. */
export function openSideBySide(layerId: string, left?: '3d'): void {
  const id = workspace.getState().project?.id;
  if (!id) return;
  const s = shell.getState();
  const split = stagePrefs.getState().byProject[id]?.split ?? DEFAULT_SPLIT;
  stagePrefs.getState().update(id, { split: sideBySide(split, left ?? s.stageMode, layerId) });
  if (s.screen !== 'scene') s.go('scene');
  s.setStageMode('split');
}

/** Open the place tool on a drawing: the 3D view on the left, the drawing on the right. */
export function startPlacing(layerId: string): void {
  openSideBySide(layerId, '3d');
  drawings.getState().startPlace(layerId);
}

/**
 * The controls of one drawing, under its row in the Datasets list: how it lies over the site
 * (opacity in 3D and on the map, on top of models in 3D), side by side, and placing it.
 */
export function DrawingControls({
  layerId,
  name,
  canEdit,
}: {
  layerId: string;
  name: string;
  /** False in a package or for a look-only reviewer: nothing is placed. */
  canEdit: boolean;
}) {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const all = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.drawings : undefined));
  const placed = useDrawings((s) => s.placed[layerId]);
  const placing = useDrawings((s) => s.place?.layerId === layerId);
  const display = all?.[layerId];
  const opacity = display?.opacity ?? DEFAULT_OPACITY;
  const onTop = display?.onTop === true;
  if (!projectId) return null;
  const set = (patch: { opacity?: number; onTop?: boolean }) => {
    stagePrefs.getState().update(projectId, { drawings: withDrawingDisplay(all, layerId, patch) });
  };
  return (
    <div className="pop-form dctl" data-testid={`drawing-controls-${layerId}`}>
      {placed?.provisional && (
        <p className="pop-note" data-testid="drawing-unplaced">
          Not placed yet, so it is hidden in 3D and on the map. It opens side by side as it is.
        </p>
      )}
      <label className="pop-row">
        <span>Opacity</span>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={opacity}
          aria-label={`Opacity of ${name}`}
          onChange={(e) => {
            set({ opacity: Number(e.target.value) });
          }}
        />
        <span className="mono">{Math.round(opacity * 100)} %</span>
      </label>
      <div className="pop-row">
        <span className="pop-grow" id={`dctl-top-${layerId}`}>
          On top in 3D
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={onTop}
          aria-labelledby={`dctl-top-${layerId}`}
          title="Draw it over models and point clouds instead of behind them"
          onClick={() => {
            set({ onTop: !onTop });
          }}
        />
      </div>
      <div className="dctl-acts">
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            openSideBySide(layerId);
          }}
        >
          <Icon name="split" size={14} />
          Side by side
        </button>
        {canEdit && placed && (
          <button
            type="button"
            className={placing ? 'btn sm primary' : 'btn sm'}
            aria-pressed={placing}
            onClick={() => {
              if (placing) drawings.getState().stopPlace();
              else startPlacing(layerId);
            }}
          >
            <Icon name="target" size={14} />
            {placed.provisional ? 'Place on the site' : 'Place again'}
          </button>
        )}
      </div>
    </div>
  );
}
