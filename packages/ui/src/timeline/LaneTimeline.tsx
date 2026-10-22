import type { ClockStore } from '@aio/workspace';
import {
  memo,
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { formatDate } from '../format';
import { t } from '../i18n';
import { Icon } from '../icons/Icon';
import { laneTodOf, utcAt, type Lane, type LaneClip, type LaneModel } from './lanes';
import {
  HideButton,
  KeyframeDiamond,
  Playhead,
  Ruler,
  Transport,
  ZoomControls,
  useTimeAxis,
} from './parts';

export interface LaneTimelineProps {
  model: LaneModel;
  /** The project clock; the playhead, ghost lines and timecode follow it on their own. */
  clock: ClockStore;
  playing: boolean;
  rate: number;
  activeClip: string | null;
  selectedIssue?: string | null | undefined;
  /** Date tag colour by capture id. */
  colours?: Readonly<Record<string, string>> | undefined;
  /**
   * The focused date control (date in full, opens the calendar), placed in the corner above the
   * lane labels so the header row keeps room for the transport at the narrowest window.
   */
  dateSlot?: ReactNode | undefined;
  /** "site time ≈ UTC+3" or "UTC". */
  clockLabel: string;
  onFocusLane: (captureId: string) => void;
  onExpand: (side: 'earlier' | 'later') => void;
  /** Seek to a project time (UTC ms). */
  onSeek: (utcMs: number) => void;
  /** A clip was chosen; `atUtcMs` is the clicked time when a pointer clicked its bar. */
  onClip: (layerId: string, atUtcMs?: number) => void;
  onIssue?: ((issueId: string) => void) | undefined;
  onKeyframe?: ((layerId: string, index: number) => void) | undefined;
  onKeyframeMove?:
    ((layerId: string, index: number, utcMs: number, phase: 'move' | 'end') => void) | undefined;
  onStep: (dir: 1 | -1) => void;
  onTogglePlay: () => void;
  onRate: (rate: number) => void;
  onHide?: (() => void) | undefined;
}

const vars = (v: Record<string, number>) => v as CSSProperties;
/** UTC time of a time of day inside a clip. */
const utcIn = (c: LaneClip, tod: number) => c.startMs + (tod - c.startTod);

/**
 * One lane per survey date on a shared site time-of-day axis: the focused date full height with
 * names, issues, photos and keyframes and the real playhead; the other visible dates dimmed with
 * their clips (photos and issues too when they have no video) and a ghost line at the same time of
 * day. Purely presentational; a clock tick moves only the lines and the timecode.
 */
export const LaneTimeline = memo(function LaneTimeline(props: LaneTimelineProps) {
  const { model, clock, playing, rate, activeClip, selectedIssue } = props;
  const tracksRef = useRef<HTMLDivElement>(null);
  const focused = model.visible.find((l) => l.captureId === model.focus);
  const { offsetMin } = model;
  const headAt = useCallback(
    (nowMs: number) => (focused ? laneTodOf(focused, nowMs, offsetMin) : null),
    [focused, offsetMin],
  );
  const axis = useTimeAxis(tracksRef, model.range);
  const { x, pct, timeAt, width } = axis;
  const anchor = useCallback(
    () => headAt(clock.getState().nowMs) ?? (model.range[0] + model.range[1]) / 2,
    [headAt, clock, model.range],
  );
  const active = model.lanes.flatMap((l) => l.clips).find((c) => c.layerId === activeClip);
  const hasClips = model.lanes.some((l) => l.clips.length > 0);

  const scrub = useRef<Lane | null>(null);
  const laneAt = (el: HTMLElement): Lane | undefined => {
    const id = el.closest<HTMLElement>('[data-lane]')?.dataset.lane;
    return model.visible.find((l) => l.captureId === id);
  };
  const seekIn = (lane: Lane, clientX: number) => {
    props.onSeek(utcAt(lane, timeAt(clientX), model.offsetMin));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-hit]')) return;
    const lane = laneAt(target) ?? focused;
    if (!lane) return;
    // dragging in another lane focuses that date first
    if (lane.captureId !== model.focus) props.onFocusLane(lane.captureId);
    scrub.current = lane;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekIn(lane, e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub.current) seekIn(scrub.current, e.clientX);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrub.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onClipClick = (lane: Lane, c: LaneClip, e: ReactMouseEvent) => {
    if (lane.captureId !== model.focus) props.onFocusLane(lane.captureId);
    // keyboard activation has no pointer position: the binding picks the time
    if (e.detail === 0) {
      props.onClip(c.layerId);
      return;
    }
    const at = utcIn(c, timeAt(e.clientX));
    props.onClip(c.layerId, Math.min(Math.max(at, c.startMs), Math.max(c.startMs, c.endMs - 250)));
  };

  const fold = (side: 'earlier' | 'later', count: number) =>
    count > 0 && (
      <button
        type="button"
        className="lt-fold"
        data-testid={`lane-fold-${side}`}
        aria-expanded={false}
        onClick={() => {
          props.onExpand(side);
        }}
      >
        {t(side === 'earlier' ? 'timeline.lanes.earlier' : 'timeline.lanes.later', { count })}
        <Icon name="chevdown" size={12} />
      </button>
    );
  const foldTrack = (count: number) => count > 0 && <div className="lt-fold-trk" />;

  const track = (lane: Lane) => {
    const on = lane.captureId === model.focus;
    // dates without video keep their photos and issues, the dimmed video lanes show only clips
    const marks = on || lane.clips.length === 0;
    return (
      <div
        key={lane.captureId}
        className={`trk lt-lane${on ? ' on' : ''}`}
        data-lane={lane.captureId}
        data-testid={`lane-${lane.captureId}`}
        style={vars({ '--rows': Math.max(1, lane.rows) })}
      >
        {lane.clips.map((c) => {
          const left = x(c.startTod);
          const w = x(c.endTod) - left;
          if (left + w < -1 || left > 101) return null;
          const sel = c.layerId === activeClip;
          return (
            <span key={c.layerId}>
              <button
                type="button"
                data-hit
                data-testid="lane-clip"
                className={`seg-c${sel ? ' on' : ''}${c.estimated ? ' est' : ''}`}
                style={{
                  left: `${left}%`,
                  width: `calc(${w}% - 1px)`,
                  ...vars({ '--row': c.row }),
                }}
                title={`${c.name}${c.estimated ? ' (length not known yet)' : ''}`}
                aria-pressed={sel}
                onClick={(e) => {
                  onClipClick(lane, c, e);
                }}
              >
                {on && (w / 100) * width > 96 ? c.name : ''}
              </button>
              {on &&
                c.keysTod?.map((k, i) => (
                  <KeyframeDiamond
                    // keyed by index: a drag moves the key time live, and a remount would drop the drag
                    key={i}
                    layerId={c.layerId}
                    index={i}
                    name={c.name}
                    style={{ left: `${x(k)}%`, ...vars({ '--row': c.row }) }}
                    timeAt={(clientX) => utcIn(c, timeAt(clientX))}
                    onKeyframe={props.onKeyframe}
                    onKeyframeMove={props.onKeyframeMove}
                  />
                ))}
            </span>
          );
        })}
        {marks &&
          lane.photos.map((p) => (
            <i key={`${p.layerId}/${p.photoId}`} className="tick" style={{ left: pct(p.tod) }} />
          ))}
        {marks &&
          lane.issues.map((m) => (
            <button
              key={m.issueId}
              type="button"
              data-hit
              className={`dia${m.issueId === selectedIssue ? ' sel' : ''}`}
              style={{ left: pct(m.tod), ...(m.color ? { background: m.color } : {}) }}
              title={`${m.code}, severity ${String(m.severity)}`}
              aria-label={`Issue ${m.code}`}
              onClick={() => {
                if (!on) props.onFocusLane(lane.captureId);
                props.onSeek(m.tMs);
                props.onIssue?.(m.issueId);
              }}
            />
          ))}
        {focused && (
          <Playhead
            clock={clock}
            axis={axis}
            at={headAt}
            follow={on && playing}
            className={on ? 'playhead' : 'lt-ghost'}
            testId={on ? 'playhead' : 'ghost-line'}
          />
        )}
      </div>
    );
  };

  return (
    // Time runs left to right in every UI direction.
    <div className="tl lt" aria-label="Timeline" dir="ltr" data-testid="lane-timeline">
      <div className="tl-h">
        <Transport
          canStep={(focused?.clips.length ?? 0) > 0}
          canPlay={hasClips}
          playing={playing}
          clock={clock}
          shiftMs={model.offsetMin * 60_000}
          rate={rate}
          activeName={active?.name}
          onStep={props.onStep}
          onTogglePlay={props.onTogglePlay}
          onRate={props.onRate}
        />
        {/* shrinks to an ellipsis when the bar is narrow; the title keeps it readable */}
        <span className="ctx lt-clock" data-testid="lane-clock" title={props.clockLabel}>
          {props.clockLabel}
        </span>
        <ZoomControls axis={axis} anchor={anchor} />
        {props.onHide && <HideButton onHide={props.onHide} />}
      </div>
      <div className="tl-body lt-body">
        <div className="tl-labels">
          <div className="tl-ruler-l lt-corner">{props.dateSlot}</div>
          {fold('earlier', model.folds.earlier)}
          {model.visible.map((l) => {
            const on = l.captureId === model.focus;
            return (
              <button
                key={l.captureId}
                type="button"
                className={`lt-label${on ? ' on' : ''}`}
                data-testid={`lane-label-${l.captureId}`}
                aria-pressed={on}
                aria-label={t('timeline.lanes.focus', { date: formatDate(l.date) })}
                title={l.label}
                style={vars({ '--rows': Math.max(1, l.rows) })}
                onClick={() => {
                  props.onFocusLane(l.captureId);
                }}
              >
                <span
                  className="dtag"
                  style={{ background: props.colours?.[l.captureId] }}
                  aria-hidden="true"
                />
                {formatDate(l.date)}
                {on && <span className="tm">{l.clips.length}</span>}
              </button>
            );
          })}
          {fold('later', model.folds.later)}
        </div>
        <div
          className="tl-tracks lt-tracks"
          ref={tracksRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="timeline-tracks"
        >
          <Ruler axis={axis} />
          {foldTrack(model.folds.earlier)}
          {model.visible.map(track)}
          {foldTrack(model.folds.later)}
        </div>
      </div>
    </div>
  );
});
