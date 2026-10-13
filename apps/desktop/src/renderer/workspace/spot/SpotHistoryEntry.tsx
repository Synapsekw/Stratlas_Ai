import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useCaptureIndex } from '../compare';
import { SpotStrip } from './SpotStrip';
import { SpotThumb } from './SpotThumb';
import type { SpotOpen } from './spotTypes';
import { openSpotHistory, startAt } from './spotViewerStore';
import { useSpotHistory } from './useSpotHistory';

/** "Other dates": opens the spot viewer on this image; nothing with fewer than two survey dates. */
export function SpotHistoryButton(p: { open: SpotOpen; label?: boolean }) {
  const t = useT();
  const dates = useCaptureIndex()?.captures.length ?? 0;
  if (dates < 2) return null;
  return (
    <button
      type="button"
      className={`btn sm ghost${p.label ? '' : ' icon'}`}
      title={t('spot.openTip')}
      aria-label={t('spot.open')}
      data-testid="spot-history-open"
      onClick={() => {
        openSpotHistory(p.open);
      }}
    >
      <Icon name="history" size={14} />
      {p.label && t('spot.open')}
    </button>
  );
}

/** The strip under the Media photo viewer: the dates at a glance, a slot opens the viewer there. */
export function InlineSpotStrip(p: { open: SpotOpen }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  // the flight logs are read and the search run only when there are dates to compare
  const dates = useCaptureIndex()?.captures.length ?? 0;
  const { index, result, tags, origin } = useSpotHistory(p.open, dates >= 2);
  if (!project || !index || dates < 2 || !result) return null;
  if ('error' in result)
    return (
      <p className="spot-nopos faint small" data-testid="spot-no-position">
        {t(p.open.item.kind === 'walk' ? 'spot.noPositionWalk' : 'spot.noPosition')}
      </p>
    );
  return (
    <div data-testid="spot-inline">
      <SpotStrip
        compact
        history={result.history}
        at={startAt(result.history, origin)}
        tags={tags}
        origin={p.open.item.kind}
        thumb={(m) => (
          <SpotThumb projectId={project.id} layers={project.manifest.layers} match={m} />
        )}
        onPick={(at) => {
          openSpotHistory(p.open, at);
        }}
      />
    </div>
  );
}
