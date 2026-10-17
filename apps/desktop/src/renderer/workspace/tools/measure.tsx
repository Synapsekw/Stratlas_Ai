/**
 * The Measure group's actions: the one Distance tool (M, "Measure a distance", D19) and the
 * section plane (X). The full set is the Measure workbench (workbench/benches/MeasureBench).
 */
import type { EngineStage, SectionState } from '@aio/engine';
import { shell } from '../../shell';
import { measureStore, startTool, stopTool } from '../../survey/measureStore';

/** Compass bearing from the orbit target toward the camera: the half a viewer wants removed. */
function cameraBearing(stage: EngineStage): number {
  const v = stage.camera.position.clone().sub(stage.controls.target);
  return Math.round(((Math.atan2(v.x, -v.z) * 180) / Math.PI + 360) % 360);
}

/** The Distance tool is on (the plain tool, not a template built on it). */
export function distanceOn(): boolean {
  const tool = measureStore.getState().tool;
  return tool?.tool === 'distance' && !tool.template;
}

/**
 * The survey Distance on (M, "Measure a distance"), or off again. A read-only project or a
 * package measures without saving (D6, D19). The view's own measure tool is not used any more:
 * the view goes back to selecting, so its picks reach the drawing.
 */
export function toggleMeasure(stage: EngineStage | null): void {
  if (distanceOn()) {
    stopTool();
    return;
  }
  if (stage && stage.tool !== 'select') stage.setTool('select');
  const transient = measureStore.getState().readOnly || shell.getState().pkg !== null;
  startTool('distance', { transient });
}

/** Turn the section on toward the camera, or off. */
export function toggleSection(stage: EngineStage): void {
  const s = stage.section;
  stage.setSection(
    s.enabled
      ? { enabled: false }
      : s.mode === 'vertical'
        ? { enabled: true, bearingDeg: cameraBearing(stage) }
        : { enabled: true },
  );
}

/** The section plane's settings: on, direction, bearing, offset and which half stays. */
export function SectionPanel({ stage }: { stage: EngineStage }) {
  const s = stage.section;
  const set = (patch: Partial<SectionState>) => {
    stage.setSection(patch);
  };
  return (
    <div className="pop-form">
      <label className="pop-row">
        <span>Section</span>
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={() => {
            toggleSection(stage);
          }}
        />
      </label>
      <div className="seg" role="group" aria-label="Cut direction">
        {(['vertical', 'horizontal'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={s.mode === m}
            onClick={() => {
              set({ mode: m, enabled: true });
            }}
          >
            {m === 'vertical' ? 'Vertical' : 'Horizontal'}
          </button>
        ))}
      </div>
      {s.mode === 'vertical' && (
        <label className="pop-row">
          <span>Bearing</span>
          <input
            type="range"
            min={0}
            max={359}
            value={s.bearingDeg}
            onChange={(e) => {
              set({ bearingDeg: Number(e.target.value), enabled: true });
            }}
          />
          <span className="mono">{String(s.bearingDeg).padStart(3, '0')}°</span>
        </label>
      )}
      <label className="pop-row">
        <span>Offset</span>
        <input
          type="range"
          min={-20}
          max={20}
          step={0.05}
          value={s.offset}
          onChange={(e) => {
            set({ offset: Number(e.target.value), enabled: true });
          }}
        />
        <span className="mono">{s.offset.toFixed(2)} m</span>
      </label>
      <label className="pop-row">
        <span>Keep other half</span>
        <input
          type="checkbox"
          checked={s.flip}
          onChange={(e) => {
            set({ flip: e.target.checked });
          }}
        />
      </label>
    </div>
  );
}
