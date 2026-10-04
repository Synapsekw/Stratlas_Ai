import {
  defaultEnvironment,
  defaultTime,
  type EngineStage,
  type EnvironmentMode,
} from '@aio/engine';
import { useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useReducer, useState } from 'react';
import { PopTool } from '../workspace/StageTools';
import { hhmm, siteClock, siteInstant } from './envClock';
import { envPrefs, type EnvPref } from './envPrefs';
import './environment.css';

/** Change the open project's environment: remembered per project, applied to the stage. */
function change(patch: EnvPref) {
  const id = workspace.getState().project?.id;
  if (id) envPrefs.getState().set(id, patch);
}

/**
 * Apply the open project's environment to the stage: the engine's defaults for the project
 * (sky for a placed site with imagery, the capture time, water from the data) with the user's
 * per-project choices on top. Re-applies on project change and on every choice.
 */
export function useStageEnvironment(stage: EngineStage | null): void {
  useEffect(() => {
    if (!stage) return;
    const apply = () => {
      const p = workspace.getState().project;
      if (!p) return;
      const pref = envPrefs.getState().byProject[p.id] ?? {};
      stage.setEnvironment({ ...defaultEnvironment(p.manifest, Date.now()), ...pref });
    };
    apply();
    const offPrefs = envPrefs.subscribe((s, prev) => {
      const id = workspace.getState().project?.id;
      if (id && s.byProject[id] !== prev.byProject[id]) apply();
    });
    // the stage resets to the defaults on its own project change; this runs after it
    const offWs = workspace.subscribe((s, prev) => {
      if (s.project?.id !== prev.project?.id) apply();
    });
    return () => {
      offPrefs();
      offWs();
    };
  }, [stage]);
}

/** Backdrop, sun and time of day, and water for the 3D stage, in a stage popover. */
export function EnvironmentTool({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => stage?.onStateChange(bump), [stage]);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  if (!stage || !manifest) return null;
  const env = stage.environment;
  return (
    <PopTool icon="sun" label={t('stage.env.button')} pressed={env.mode === 'sky'} wide>
      <EnvironmentPanel stage={stage} originH={manifest.origin[2]} />
    </PopTool>
  );
}

function EnvironmentPanel({ stage, originH }: { stage: EngineStage; originH: number }) {
  const t = useT();
  const env = stage.environment;
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const loc = env.location;
  const offset = loc?.utcOffsetHours ?? 0;
  const clock = siteClock(env.timeMs, offset);
  const sky = env.mode === 'sky';
  const setMode = (mode: EnvironmentMode) => {
    change({ mode });
  };
  const setClock = (date: string, minutes: number) => {
    const ms = siteInstant(date, minutes, offset);
    if (ms !== null) change({ timeMs: ms });
  };
  const el = Math.round(env.sun.elevationDeg);
  const az = Math.round(env.sun.azimuthDeg);
  const dataLevel = env.dataWaterLevel;
  const levelEl = env.waterLevel ?? dataLevel;
  // a draft so the field can be cleared or half typed
  const [draft, setDraft] = useState<string | null>(null);
  const levelText = draft ?? (env.waterLevel !== null ? (env.waterLevel + originH).toFixed(2) : '');
  const commitLevel = (text: string) => {
    setDraft(null);
    const v = text.trim() === '' ? null : Number(text);
    if (v === null) change({ waterLevel: null, water: true });
    else if (Number.isFinite(v)) change({ waterLevel: v - originH, water: true });
  };
  const tz = `${offset >= 0 ? '+' : ''}${String(offset)}`;
  return (
    <div className="pop-form env-pop" data-testid="env-panel">
      <span className="pop-title">{t('stage.env.title')}</span>
      <div className="seg pop-seg" role="group" aria-label={t('stage.env.backdrop')}>
        {(['sky', 'studio'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={env.mode === m}
            onClick={() => {
              setMode(m);
            }}
          >
            {t(m === 'sky' ? 'stage.env.sky' : 'stage.env.studio')}
          </button>
        ))}
      </div>
      <p className="pop-note">
        {sky
          ? loc
            ? t('stage.env.skyHint')
            : t('stage.env.noLocation')
          : t('stage.env.studioHint')}
      </p>
      {sky && loc && (
        <>
          <label className="pop-row">
            <span>{t('stage.env.date')}</span>
            <input
              type="date"
              className="env-date"
              value={clock.date}
              required
              onChange={(e) => {
                if (e.target.value) setClock(e.target.value, clock.minutes);
              }}
            />
            <span className="mono env-tz">{t('stage.env.utc', { offset: tz })}</span>
          </label>
          <label className="pop-row">
            <span>{t('stage.env.time')}</span>
            <input
              type="range"
              min={0}
              max={1435}
              step={5}
              value={clock.minutes - (clock.minutes % 5)}
              aria-label={t('stage.env.timeOfDay')}
              aria-valuetext={hhmm(clock.minutes)}
              data-testid="env-time"
              onChange={(e) => {
                setClock(clock.date, Number(e.target.value));
              }}
            />
            <span className="mono">{hhmm(clock.minutes)}</span>
          </label>
          <div className={`env-sun mono${el < 0 ? ' night' : ''}`} data-testid="env-sun">
            {el >= 0
              ? t('stage.env.sun', { elevation: el, azimuth: az })
              : t('stage.env.night', { elevation: -el })}
          </div>
          <div className="env-quick">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                if (manifest) change({ timeMs: defaultTime(manifest, Date.now()) });
              }}
            >
              {t('stage.env.captureTime')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                change({ timeMs: Date.now() });
              }}
            >
              {t('stage.env.now')}
            </button>
          </div>
        </>
      )}
      <label className="pop-row">
        <span className="pop-grow">{t('stage.env.water')}</span>
        <input
          type="checkbox"
          checked={env.water}
          data-testid="env-water"
          onChange={(e) => {
            change({ water: e.target.checked });
          }}
        />
      </label>
      {env.water && (
        <>
          <label className="pop-row">
            <span>{t('stage.env.waterLevel')}</span>
            <input
              type="number"
              className="env-level mono"
              step={0.1}
              value={levelText}
              placeholder={dataLevel !== null ? (dataLevel + originH).toFixed(2) : ''}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onBlur={(e) => {
                commitLevel(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLevel(e.currentTarget.value);
                if (e.key === 'Escape') setDraft(null);
              }}
            />
            <span className="mono">{t('stage.env.waterUnit')}</span>
          </label>
          <p className="pop-note">
            {env.waterLevel !== null
              ? t('stage.env.waterSet')
              : levelEl !== null
                ? t('stage.env.waterFromData', { level: (levelEl + originH).toFixed(2) })
                : t('stage.env.waterNone')}
          </p>
        </>
      )}
      <button
        type="button"
        className="btn sm ghost env-reset"
        onClick={() => {
          const id = workspace.getState().project?.id;
          if (id) envPrefs.getState().reset(id);
        }}
      >
        {t('stage.env.reset')}
      </button>
    </div>
  );
}
