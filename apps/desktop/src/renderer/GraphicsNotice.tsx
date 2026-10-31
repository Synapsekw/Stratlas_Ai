import { t } from '@aio/ui';
import { useToastNotice } from './exports/useToastNotice';
import { GPU_TIERS, graphics, useGraphics } from './graphics';

/**
 * The calm notice after the app stepped down a graphics tier under memory pressure (memoryWatch.ts):
 * what happened, the preset now in use, and that it lasts for this session. A toast on the host.
 */
export function GraphicsNotice() {
  const reason = useGraphics((s) => s.pressureReason);
  const tier = useGraphics((s) => s.tier);
  useToastNotice(
    'graphics-notice',
    reason
      ? {
          message: t('graphics.pressure.title'),
          detail: t(
            reason === 'context-lost'
              ? 'graphics.pressure.contextLost'
              : 'graphics.pressure.memory',
            { tier: GPU_TIERS[tier].label },
          ),
          icon: 'refresh',
          testId: 'graphics-notice',
          closeLabel: t('graphics.pressure.dismiss'),
          onDismiss: () => {
            graphics().getState().dismissPressure();
          },
        }
      : null,
  );
  return null;
}
