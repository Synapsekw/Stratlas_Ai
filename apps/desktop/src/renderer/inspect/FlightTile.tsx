import type { Layer } from '@aio/schema';
import { formatClock, formatCount, formatDuration, Icon, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { showsClipList, type FlightCard } from '../screens/mediaModel';
import { shell } from '../shell';
import { MediaThumb } from '../thumbs/Thumb';
import { selectClip } from '../workspace/pickClip';

/** "Flight 101 · Shell pass 1 · clip 3 of 7" reads "clip 3 of 7" under its flight. */
export function clipLabel(name: string, flight: string): string {
  const rest = name.startsWith(flight) ? name.slice(flight.length).replace(/^[\s·:,|/-]+/, '') : '';
  return rest || name;
}

/** Play a clip in the Scene from its start. */
export function playClip(c: Extract<Layer, { kind: 'video' }>) {
  selectClip(c.id);
  workspace.getState().setTime(c.flight.startUtcMs + c.offsetMs);
  shell.getState().go('scene');
}

export function FlightTile({
  flight,
  projectId,
  open,
  playing,
  onOpen,
}: {
  flight: FlightCard;
  projectId: string;
  open: boolean;
  playing: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const first = flight.clips[0];
  const n = flight.clips.length;
  // a one-clip flight lists no clips under it: there is nothing to expand, the card plays
  const listed = showsClipList(flight);
  return (
    <div className={`m-card m-flight${open ? ' on' : ''}`}>
      <button
        type="button"
        className="m-flight-main"
        aria-expanded={listed ? open : undefined}
        aria-controls={listed ? 'm-flight-clips' : undefined}
        onClick={() => {
          // the card of a one-clip flight is that clip: it plays it, as the play icon does
          if (!listed && first) playClip(first);
          else onOpen();
        }}
      >
        <div className="m-poster">
          <MediaThumb projectId={projectId} asset={flight.poster} icon="video" thumb={false} />
          <span className="m-badge mono">
            {flight.estimated ? '~' : ''}
            {formatDuration(flight.endMs - flight.startMs)}
          </span>
          {playing && <span className="m-live">Active</span>}
        </div>
        <div className="m-meta">
          <b>{flight.name}</b>
          <span className="mono">
            {formatClock(flight.startMs)} UTC ·{' '}
            {t('media.count.clips', { count: n, n: formatCount(n) })}
          </span>
        </div>
      </button>
      {first && (
        <button
          type="button"
          className="btn icon sm m-play"
          aria-label={`Play ${flight.name} in the scene`}
          title="Play in the scene"
          onClick={() => {
            playClip(first);
          }}
        >
          <Icon name="play" size={14} />
        </button>
      )}
    </div>
  );
}
