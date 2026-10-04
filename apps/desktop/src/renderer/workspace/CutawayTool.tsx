import type { EngineStage } from '@aio/engine';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { setCameraMode, videoRig } from '@aio/video';
import { CUTAWAY_MODES, MAX_OPACITY, MIN_OPACITY, type CutawayMode } from './cutaway';
import {
  insideView,
  setCutawayMode,
  setCutawayOpacity,
  useCutawayPref,
  useCutawayState,
} from './useCutaway';

const LABEL: Record<CutawayMode, MessageKey> = {
  off: 'stage.cutaway.off',
  cut: 'stage.cutaway.cut',
  transparent: 'stage.cutaway.transparent',
};

const HINT: Record<CutawayMode, MessageKey> = {
  off: 'stage.cutaway.offHint',
  cut: 'stage.cutaway.cutHint',
  transparent: 'stage.cutaway.transparentHint',
};

/** The panel of the stage's cut-away tool: Off, Cut or Transparent, opacity and Inside view. */
export function CutawayPanel({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const { mode, opacity } = useCutawayPref();
  const inside = useCutawayState((s) => s.inside);
  return (
    <div className="pop-form" data-testid="cutaway-panel">
      <span className="pop-title">{t('stage.cutaway.title')}</span>
      <div className="seg pop-seg" role="group" aria-label={t('stage.cutaway.modes')}>
        {CUTAWAY_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              setCutawayMode(m);
            }}
          >
            {t(LABEL[m])}
          </button>
        ))}
      </div>
      {mode === 'transparent' && (
        <label className="pop-row">
          <span>{t('stage.cutaway.opacity')}</span>
          <input
            type="range"
            min={MIN_OPACITY}
            max={MAX_OPACITY}
            step={0.05}
            value={opacity}
            aria-label={t('stage.cutaway.opacity')}
            onChange={(e) => {
              setCutawayOpacity(Number(e.target.value));
            }}
          />
          <span className="mono">{Math.round(opacity * 100)} %</span>
        </label>
      )}
      <p className="pop-note">{t(HINT[mode])}</p>
      <button
        type="button"
        className="btn sm"
        disabled={!stage || !inside}
        title={inside ? t('stage.cutaway.insideViewTip') : t('stage.cutaway.droneOutside')}
        onClick={() => {
          if (!stage) return;
          if (videoRig(stage).cameraMode === 'drone') setCameraMode(stage, 'free');
          insideView(stage);
        }}
      >
        <Icon name="cutaway" size={14} />
        {t('stage.cutaway.insideView')} <span className="kbd">C</span>
      </button>
    </div>
  );
}
