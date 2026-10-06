import { Icon, t } from '@aio/ui';
import { GPU_TIERS, graphics, useGraphics } from './graphics';

/**
 * The calm notice after the app stepped down a graphics tier under memory pressure (memoryWatch.ts):
 * what happened, the preset now in use, and that it lasts for this session. Lives in the toast
 * stack, bottom right.
 */
export function GraphicsNotice() {
  const reason = useGraphics((s) => s.pressureReason);
  const tier = useGraphics((s) => s.tier);
  if (!reason) return null;
  const vars = { tier: GPU_TIERS[tier].label };
  return (
    <div className="toast" data-testid="graphics-notice">
      <div className="toast-h">
        <Icon name="refresh" size={14} />
        <b>{t('graphics.pressure.title')}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('graphics.pressure.dismiss')}
          onClick={() => {
            graphics().getState().dismissPressure();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p">
        {t(
          reason === 'context-lost' ? 'graphics.pressure.contextLost' : 'graphics.pressure.memory',
          vars,
        )}
      </div>
    </div>
  );
}
