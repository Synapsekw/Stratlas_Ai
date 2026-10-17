/**
 * The Video and camera group: the video window, flight paths, telemetry and camera views. Seeing
 * inside the asset (Cutaway) is in View, which every 3D project has (ruling I-R17).
 */
import type { EngineStage } from '@aio/engine';
import { useT, type IconName } from '@aio/ui';
import { setCameraMode, videoRig, type CameraMode } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import { useReducer } from 'react';
import { shell, useShell } from '../../shell';
import { PATH_MODES, setPathMode } from '../flightPaths';
import { updateFlightPaths, useFlightPathModel } from '../pathModel';
import { PopTool, Tool } from '../StageTools';
import { toggleTelemetry, useTelemetryOn } from '../telemetryPref';

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

/** All, active clip only or no flight paths in 3D (P turns them off and back on). */
export function FlightPathTool() {
  const m = useFlightPathModel();
  if (!m) return null;
  return (
    <PopTool
      icon="path"
      label="Flight paths"
      shortcut="scene.flightPaths"
      pressed={m.pref.mode !== 'off'}
      wide
    >
      <FlightPathPanel />
    </PopTool>
  );
}

/** Drone telemetry while a clip plays: flown track, distance ticks and the HUD (D). */
export function TelemetryTool() {
  const t = useT();
  const on = useTelemetryOn();
  if (!useFlightPathModel()) return null;
  return (
    <Tool
      icon="telemetry"
      label={on ? t('stage.telemetry.hide') : t('stage.telemetry.show')}
      shortcut="scene.telemetry"
      pressed={on}
      onClick={toggleTelemetry}
    />
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

/** Video window, flight paths, telemetry and the free, follow-cam and drone-eye views. */
export function VideoTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const activeClip = useWorkspace((s) => s.activeClip);
  const videoHidden = useShell((s) => s.videoHidden);
  const showVideo = activeClip !== null && !videoHidden;
  const modes = useCameraModes(stage);
  return (
    <>
      <Tool
        icon="video"
        label={showVideo ? 'Hide the video window' : 'Show the video window'}
        shortcut="scene.video"
        pressed={showVideo}
        disabled={activeClip === null}
        onClick={() => {
          shell.getState().setVideoHidden(!videoHidden);
        }}
      />
      {!map && <FlightPathTool />}
      {!map && <TelemetryTool />}
      {!map &&
        modes.map((m) => (
          <Tool
            key={m.mode}
            icon={m.icon}
            label={m.label}
            pressed={m.pressed}
            disabled={m.disabled}
            onClick={m.choose}
          />
        ))}
    </>
  );
}
