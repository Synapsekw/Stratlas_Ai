/** The island's live line (the highest-priority live item) and the bubble's glyph for the next one. */
import { Icon, t, useT } from '@aio/ui';
import type { LiveItem } from './islandModel';

const percent = (progress: number) => t('island.percent', { pct: Math.floor(progress * 100) });
const reading = (name: string, value: string | null) =>
  value ? t('island.liveReading', { name, value }) : name;

/** What a live item says in full, for the bubble's tooltip. */
export function liveText(item: LiveItem): string {
  switch (item.kind) {
    case 'tool':
      return reading(item.label, item.reading);
    case 'playback':
      return reading(item.clip, item.telemetry);
    case 'job':
      return reading(item.label, percent(item.progress));
    case 'connection':
      return t(
        item.state === 'offline'
          ? 'island.offline'
          : item.state === 'reconnecting'
            ? 'island.reconnecting'
            : 'island.backOnline',
      );
  }
}

/** A job's progress is said at every quarter, not at every percent. */
const SAY_STEPS = 4;

/**
 * What the polite live region says of a live item: a reading the person makes (a tool's), a
 * clip's name (not its telemetry, which changes all through the clip), a job at coarse steps, the
 * connection. The island says it again only when this text changes.
 */
export function liveSay(item: LiveItem): string {
  switch (item.kind) {
    case 'playback':
      return item.clip;
    case 'job':
      return reading(item.label, percent(Math.floor(item.progress * SAY_STEPS) / SAY_STEPS));
    case 'tool':
    case 'connection':
      return liveText(item);
  }
}

/** A progress ring, `size` px across. */
function Ring({ progress, size }: { progress: number; size: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="isl-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      <circle className="tr" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2} />
      <circle
        className="pr"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${String(c * progress)} ${String(c)}`}
      />
    </svg>
  );
}

function ConnectionDot({ state }: { state: 'offline' | 'reconnecting' | 'back' }) {
  if (state === 'reconnecting') return <span className="isl-spin" aria-hidden />;
  return <span className={`isl-cdot ${state === 'offline' ? 'off' : 'ok'}`} aria-hidden />;
}

/** The live reading beside the date: icon, name and value. */
export function IslandLive({ item }: { item: LiveItem }) {
  useT();
  switch (item.kind) {
    case 'tool':
      return (
        <span className="isl-live" data-live="tool">
          <Icon name="ruler" size={14} className="isl-acc" />
          <span className="isl-name">{item.label}</span>
          {item.reading && <span className="isl-value">{item.reading}</span>}
        </span>
      );
    case 'playback':
      return (
        <span className="isl-live" data-live="playback">
          <Icon name="play" size={14} className="isl-acc" />
          <span className="isl-name">{item.clip}</span>
          <span className="isl-bar" aria-hidden>
            <i style={{ inlineSize: `${String(item.progress * 100)}%` }} />
          </span>
          {item.telemetry && <span className="isl-value sm">{item.telemetry}</span>}
        </span>
      );
    case 'job':
      return (
        <span className="isl-live" data-live="job">
          <Ring progress={item.progress} size={16} />
          <span className="isl-name">{item.label}</span>
          <span className="isl-value sm">{percent(item.progress)}</span>
          {item.more > 0 && <span className="isl-more">{`+${String(item.more)}`}</span>}
        </span>
      );
    case 'connection':
      return (
        <span className="isl-live" data-live="connection">
          <ConnectionDot state={item.state} />
          <span className="isl-name">{liveText(item)}</span>
        </span>
      );
  }
}

/** The bubble's glyph for the second live item. */
export function LiveGlyph({ item }: { item: LiveItem }) {
  switch (item.kind) {
    case 'tool':
      return <Icon name="ruler" size={14} />;
    case 'playback':
      return <Icon name="play" size={12} />;
    case 'job':
      return <Ring progress={item.progress} size={18} />;
    case 'connection':
      return <ConnectionDot state={item.state} />;
  }
}
