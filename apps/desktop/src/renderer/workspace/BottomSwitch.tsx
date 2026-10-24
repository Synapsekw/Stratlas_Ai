/**
 * "Dates | Footage" at the left of the bottom bar (volumetrics redesign, spec section 5), the
 * choice remembered per project. Each side is an icon (a calendar for the survey dates chart, a
 * camera for the footage) with its word beside it while the bar has room; a narrow bar (the CI
 * window with both sidebars open) keeps the icons alone, so Compare, Fit and Collapse stay in it
 * (styles.css, `@container tl-wrap`). The accessible name is the word either way.
 */
import { Icon, Tip, useT, type IconName, type MessageKey } from '@aio/ui';
import { workspace } from '@aio/workspace';
import type { ReactElement } from 'react';
import { bottomPref, type BottomPref, type BottomSlot } from './timelinePref';

const SIDES: readonly { k: BottomPref; icon: IconName; label: MessageKey; tip: MessageKey }[] = [
  { k: 'dates', icon: 'calendar', label: 'strip.switch.dates', tip: 'strip.switch.datesTip' },
  { k: 'footage', icon: 'video', label: 'strip.switch.footage', tip: 'strip.switch.footageTip' },
];

export function BottomSwitch({ slot }: { slot: BottomSlot }): ReactElement {
  const t = useT();
  const choose = (pref: BottomPref) => {
    const id = workspace.getState().project?.id;
    if (id) bottomPref.getState().set(id, pref);
  };
  return (
    <div className="seg tl-switch" role="group" aria-label={t('strip.switch.aria')}>
      {SIDES.map((s) => (
        <Tip key={s.k} content={t(s.tip)} placement="top">
          <button
            type="button"
            aria-label={t(s.label)}
            aria-pressed={slot === s.k}
            data-testid={`bottom-switch-${s.k}`}
            onClick={() => {
              choose(s.k);
            }}
          >
            <Icon name={s.icon} />
            <span className="tl-switch-label" aria-hidden="true">
              {t(s.label)}
            </span>
          </button>
        </Tip>
      ))}
    </div>
  );
}
