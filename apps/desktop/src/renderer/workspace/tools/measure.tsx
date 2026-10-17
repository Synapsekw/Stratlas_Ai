/** The Measure group: the quick distance (M), the section plane (X) and the survey tools. */
import type { EngineStage, SectionState } from '@aio/engine';
import { MeasureToolbar } from '../../survey/MeasureToolbar';
import { PopTool, Tool } from '../StageTools';

/** Compass bearing from the orbit target toward the camera: the half a viewer wants removed. */
function cameraBearing(stage: EngineStage): number {
  const v = stage.camera.position.clone().sub(stage.controls.target);
  return Math.round(((Math.atan2(v.x, -v.z) * 180) / Math.PI + 360) % 360);
}

/** The quick distance on (M, "Measure a distance") or back to selecting. */
export function toggleMeasure(stage: EngineStage): void {
  stage.setTool(stage.tool === 'measure' ? 'select' : 'measure');
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

function SectionPanel({ stage }: { stage: EngineStage }) {
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

/** Select, measure and section. */
export function MeasureTools({ stage }: { stage: EngineStage | null }) {
  const tool = stage?.tool ?? 'select';
  // No separate Select tool: the ruler toggles off and Esc returns to selecting. The survey tools
  // took its place, so the bar still fits one row at 1440 px with both side panels open.
  return (
    <>
      <Tool
        icon="ruler"
        label="Measure a distance"
        shortcut="scene.measure"
        pressed={tool === 'measure'}
        disabled={!stage}
        onClick={() => {
          if (stage) toggleMeasure(stage);
        }}
      />
      {stage && (
        <PopTool
          icon="section"
          label="Section plane"
          shortcut="scene.section"
          pressed={stage.section.enabled}
        >
          <SectionPanel stage={stage} />
        </PopTool>
      )}
      <MeasureToolbar />
    </>
  );
}
