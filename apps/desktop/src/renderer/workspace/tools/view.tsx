/**
 * The View group: whole site, centre, fly to the selection, the view presets and seeing inside the
 * asset (Cutaway: cut or transparent, with or without a clip; ruling I-R17).
 */
import type { EngineStage, ViewPreset } from '@aio/engine';
import { useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { CutawayPanel } from '../CutawayTool';
import { PopTool, Tool } from '../StageTools';
import { useCutawayPref } from '../useCutaway';

const PRESETS: { preset: ViewPreset; label: string }[] = [
  { preset: 'iso', label: 'Iso' },
  { preset: 'top', label: 'Top' },
  { preset: 'north', label: 'North' },
];

/** Whole site, centre on project, fly to the selection and the view presets (north-up top, north, isometric). */
export function ViewTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const t = useT();
  const selection = useWorkspace((s) => s.selection);
  const cut = useCutawayPref();
  return (
    <>
      <Tool
        icon="maximize"
        label="Whole site"
        shortcut="scene.home"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'home' });
        }}
      />
      <Tool
        icon="crosshair"
        label="Centre on project"
        shortcut="scene.site"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'site' });
        }}
      />
      <Tool
        icon="target"
        label="Fly to selection"
        shortcut="scene.flySelection"
        disabled={!selection}
        onClick={() => {
          if (selection) workspace.getState().flyTo({ kind: 'selection', selection });
        }}
      />
      {!map && (
        <PopTool icon="box" label="View presets" disabled={!stage}>
          <div className="seg pop-seg" role="group" aria-label="View presets">
            {PRESETS.map((p) => (
              <button
                key={p.preset}
                type="button"
                title={`${p.label} view of the whole site`}
                onClick={() => {
                  stage?.setViewPreset(p.preset);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="pop-note">The compass also flips to a north-up top view.</p>
        </PopTool>
      )}
      {!map && (
        <PopTool
          icon="cutaway"
          label={t('stage.cutaway.tool')}
          pressed={cut.mode !== 'off'}
          disabled={!stage}
          wide
        >
          <CutawayPanel stage={stage} />
        </PopTool>
      )}
    </>
  );
}
