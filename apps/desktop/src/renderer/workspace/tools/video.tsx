/**
 * What the Video workbench shows of the flight paths and the camera views (the free, follow-cam
 * and drone-eye modes).
 */
import type { EngineStage } from '@aio/engine';
import type { IconName } from '@aio/ui';
import { setCameraMode, videoRig, type CameraMode } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import { useReducer } from 'react';
import { PATH_MODES, setPathMode } from '../flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../pathModel';

/** All, active clip only or no flight paths: the segmented choice and its note (P toggles them). */
export function FlightPathPanel({ showTitle = true }: { showTitle?: boolean }) {
  const m = useFlightPathModel();
  if (!m) return null;
  const { mode } = m.pref;
  const current = PATH_MODES.find((p) => p.mode === mode);
  return (
    <div className="pop-form" data-testid="path-panel">
      {showTitle && <span className="pop-title">Flight paths</span>}
      <div className="seg pop-seg" role="group" aria-label="Flight paths">
        {PATH_MODES.map((p) => (
          <button
            key={p.mode}
            type="button"
            aria-pressed={mode === p.mode}
            title={p.hint}
            onClick={() => {
              updateFlightPaths((pref) => setPathMode(pref, p.mode));
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="pop-note">
        {current?.hint}. <span className="kbd">P</span> turns the paths off and on; the eye on a
        flight in the Video list hides that flight&apos;s path.
      </p>
    </div>
  );
}

export const CAMERA_MODES: { mode: CameraMode; label: string; icon: IconName }[] = [
  { mode: 'free', label: 'Free orbit', icon: 'orbit' },
  { mode: 'follow', label: 'Follow the drone', icon: 'follow' },
  { mode: 'drone', label: 'Drone eye (through the camera)', icon: 'droneeye' },
];

/** The camera views as the island and the Video workbench offer them, with what each does. */
export function useCameraModes(stage: EngineStage | null) {
  const activeClip = useWorkspace((s) => s.activeClip);
  const mode = stage && activeClip ? videoRig(stage).cameraMode : 'free';
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return CAMERA_MODES.map((m) => ({
    ...m,
    pressed: mode === m.mode,
    disabled: !stage || (m.mode !== 'free' && activeClip === null),
    choose: () => {
      if (!stage) return;
      setCameraMode(stage, m.mode);
      bump();
    },
  }));
}
