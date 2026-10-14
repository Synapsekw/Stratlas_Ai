import { ariaKeys, Icon, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { DateSteps } from './DatePicker';
import { toggleTimeline } from './timelinePref';

/** The lane timeline folded away: one line with the date, its arrows and calendar, and Show. */
export function DateRow() {
  const t = useT();
  return (
    <div className="date-row" role="toolbar" aria-label={t('datebar.label')} data-testid="date-row">
      <DateSteps up />
      <span className="sp" />
      <button
        type="button"
        className="tl-bar-btn"
        aria-label={t('timeline.show')}
        aria-keyshortcuts={ariaKeys('scene.timeline')}
        title={`${t('timeline.show')} (T)`}
        onClick={() => {
          toggleTimeline(workspace.getState().project);
        }}
      >
        <Icon name="clock" size={14} />
        {t('timeline.title')}
        <Icon name="chevup" size={14} />
      </button>
    </div>
  );
}
