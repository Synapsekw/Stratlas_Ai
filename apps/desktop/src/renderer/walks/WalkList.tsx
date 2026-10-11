import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { builder } from '../builder/state';
import { useShell } from '../shell';
import { useStagePrefs } from '../workspace/stagePrefs';
import { sideOf } from '../workspace/splitModel';
import { formatWalkTime, pickWalk } from './walkModel';
import { openWalk, useWalks } from './walks';

/**
 * The project's 360 videos, under the dataset tree. A walk is kept beside the manifest, not as a
 * layer, so it has no eye and no survey date yet: a row opens it in the 360 video pane of the
 * split view. The section shows only when the project has a walk.
 */
export function WalkList() {
  const t = useT();
  // a package is read-only: its walks play, nothing is added
  const readOnly = useShell((s) => s.pkg !== null);
  const projectId = useWorkspace((s) => s.project?.id);
  const list = useWalks((s) => s.walks);
  const selected = useWalks((s) => s.selected);
  const stageMode = useShell((s) => s.stageMode);
  const screen = useShell((s) => s.screen);
  const split = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.split : undefined));
  if (!projectId || list.length === 0) return null;
  // the row of the walk on screen is marked, like the selected layer in the tree
  const showing =
    screen === 'scene' && stageMode === 'split' && split && sideOf(split, 'walk360')
      ? pickWalk(list, selected)?.id
      : undefined;
  return (
    <div className="sb-sec sb-tree" data-testid="walk-list">
      <div className="tree-h sb-hide">
        <span className="caps">{t('walk.list')}</span>
        <span className="tree-h-end">
          <span className="mono faint">{list.length}</span>
          {!readOnly && (
            <button
              type="button"
              className="tree-add"
              data-testid="add-360"
              title={t('walk.add.tip')}
              onClick={() => void builder.getState().pickAndImport360()}
            >
              <Icon name="plus" size={14} />
              {t('walk.add')}
            </button>
          )}
        </span>
      </div>
      <div className="titems" role="list" aria-label={t('walk.list')}>
        {list.map((w) => (
          <div key={w.id} role="listitem">
            <button
              type="button"
              className={`titem walk-row${w.id === showing ? ' sel' : ''}`}
              aria-current={w.id === showing ? 'true' : undefined}
              aria-label={t('walk.open', { name: w.name })}
              title={w.name}
              data-testid={`walk-row-${w.id}`}
              onClick={() => {
                openWalk(w.id);
              }}
            >
              <span className="tn">{w.name}</span>
              <span className="tm">{formatWalkTime(w.video.durationS)}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
