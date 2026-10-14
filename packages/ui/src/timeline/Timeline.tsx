import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { formatCount } from '../format';
import { Icon } from '../icons/Icon';
import type { TimelineModel } from './model';
import { HideButton, KeyframeDiamond, Ruler, Transport, ZoomControls, useTimeAxis } from './parts';

export { RATES } from './parts';

export interface TimelineProps {
  model: TimelineModel;
  nowMs: number;
  playing: boolean;
  rate: number;
  activeClip: string | null;
  selectedIssue?: string | null;
  onSeek: (tMs: number) => void;
  onTogglePlay: () => void;
  onRate: (rate: number) => void;
  /** A clip was chosen; `atMs` is the clicked time when a pointer clicked its bar or flight bar. */
  onClip: (layerId: string, atMs?: number) => void;
  onIssue?: (issueId: string) => void;
  /** A camera direction keyframe diamond was clicked (index into the clip's keyframes). */
  onKeyframe?: (layerId: string, index: number) => void;
  /** A keyframe diamond is dragged to project time `tMs` (`end` once released). */
  onKeyframeMove?: (layerId: string, index: number, tMs: number, phase: 'move' | 'end') => void;
  onStep: (dir: 1 | -1) => void;
  /** Right-aligned context line, e.g. capture date and time base. */
  context?: ReactNode;
  /** Collapse the timeline (a button at the end of the header); `hideKeys` names its shortcut. */
  onHide?: () => void;
  hideKeys?: string;
  className?: string;
}

/** Below this average clip width (px) a flight's clips draw as one bar. */
const GROUP_BELOW_PX = 28;

/**
 * Mission timeline: transport, ruler, a clips track, issue diamonds, timed photos and captures,
 * and a playhead. Purely presentational; bind it to a store with props.
 */
export function Timeline(props: TimelineProps) {
  const { model, nowMs, playing, rate, activeClip, selectedIssue } = props;
  const { onSeek, onTogglePlay, onRate, onClip, onIssue, onStep } = props;
  const { onKeyframe, onKeyframeMove } = props;
  const tracksRef = useRef<HTMLDivElement>(null);
  const hasTime = model.range !== null;
  const axis = useTimeAxis(tracksRef, model.range, nowMs, playing);
  const { x, pct, timeAt, width } = axis;

  const scrubbing = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-hit]')) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(timeAt(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) onSeek(timeAt(e.clientX));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const active = model.clips.find((c) => c.layerId === activeClip);

  return (
    // Time runs left to right in every UI direction.
    <div
      className={props.className ? `tl ${props.className}` : 'tl'}
      aria-label="Timeline"
      dir="ltr"
    >
      <div className="tl-h">
        <Transport
          canStep={model.clips.length > 0}
          canPlay={hasTime}
          playing={playing}
          clockMs={hasTime ? nowMs : null}
          rate={rate}
          activeName={active?.name}
          onStep={onStep}
          onTogglePlay={onTogglePlay}
          onRate={onRate}
        />
        <span className="sp" />
        {props.context && <span className="ctx">{props.context}</span>}
        <ZoomControls axis={axis} anchor={nowMs} />
        {props.onHide && <HideButton onHide={props.onHide} hideKeys={props.hideKeys} />}
      </div>
      {hasTime ? (
        <div className="tl-body">
          <div className="tl-labels">
            <div className="tl-ruler-l" />
            <div className="trk-l">
              <Icon name="video" size={14} />
              Clips<span className="tm">{model.clips.length}</span>
            </div>
            <div className="trk-l">
              <Icon name="issues" size={14} />
              Issues<span className="tm">{model.issues.length}</span>
            </div>
            {model.photos.length > 0 && (
              <div className="trk-l">
                <Icon name="photo" size={14} />
                Photos<span className="tm">{formatCount(model.photos.length)}</span>
              </div>
            )}
            <div className="trk-l">
              <Icon name="flag" size={14} />
              Captures<span className="tm">{model.captures.length}</span>
            </div>
          </div>
          <div
            className="tl-tracks"
            ref={tracksRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            data-testid="timeline-tracks"
          >
            <Ruler axis={axis} />
            <div className="trk">
              {model.groups.map((g) => {
                const left = x(g.startMs);
                const w = x(g.endMs) - left;
                // Clips too narrow to click on their own draw as one bar for their flight.
                if (g.clips.length < 2 || ((w / 100) * width) / g.clips.length >= GROUP_BELOW_PX)
                  return null;
                if (left + w < -1 || left > 101) return null;
                const members = model.clips.filter((c) => c.group === g.id);
                const on = members.find((c) => c.layerId === activeClip);
                const within = (t: number) =>
                  `${(((t - g.startMs) / (g.endMs - g.startMs)) * 100).toFixed(3)}%`;
                return (
                  <button
                    key={g.id}
                    type="button"
                    data-hit
                    className={`seg-c grp${on ? ' has-on' : ''}`}
                    style={{ left: `${left}%`, width: `calc(${w}% - 1px)` }}
                    title={`${g.name} · ${String(members.length)} clips`}
                    aria-label={`${g.name}, ${String(members.length)} clips`}
                    aria-pressed={on !== undefined}
                    onClick={(e) => {
                      // Keyboard activation has no pointer position: play the flight's active
                      // clip, else its first.
                      if (e.detail === 0) {
                        const c = on ?? members[0];
                        if (c) onClip(c.layerId);
                        return;
                      }
                      const t = timeAt(e.clientX);
                      const hit =
                        members.find((c) => t >= c.startMs && t <= c.endMs) ??
                        members.reduce((a, b) =>
                          Math.abs((a.startMs + a.endMs) / 2 - t) <=
                          Math.abs((b.startMs + b.endMs) / 2 - t)
                            ? a
                            : b,
                        );
                      onClip(hit.layerId, Math.min(Math.max(t, hit.startMs), hit.endMs));
                    }}
                  >
                    {members.slice(1).map((c) => (
                      <i key={c.layerId} className="grp-sep" style={{ left: within(c.startMs) }} />
                    ))}
                    {on && (
                      <i
                        className="grp-on"
                        style={{
                          left: within(on.startMs),
                          width: within(g.startMs + on.endMs - on.startMs),
                        }}
                      />
                    )}
                    <span className="grp-n">{(w / 100) * width > 72 ? g.name : ''}</span>
                  </button>
                );
              })}
              {model.clips.map((c) => {
                const g = model.groups.find((gr) => gr.id === c.group);
                if (
                  g &&
                  g.clips.length >= 2 &&
                  (((x(g.endMs) - x(g.startMs)) / 100) * width) / g.clips.length < GROUP_BELOW_PX
                )
                  return null;
                const on = c.layerId === activeClip;
                const left = x(c.startMs);
                const w = x(c.endMs) - left;
                if (left + w < -1 || left > 101) return null;
                return (
                  <span key={c.layerId}>
                    <button
                      type="button"
                      data-hit
                      className={`seg-c${on ? ' on' : ''}${c.estimated ? ' est' : ''}`}
                      style={{ left: `${left}%`, width: `calc(${w}% - 1px)` }}
                      title={`${c.name}${c.estimated ? ' (length not known yet)' : ''}`}
                      aria-pressed={on}
                      onClick={(e) => {
                        // a click plays from the clicked point; keyboard activation (no
                        // pointer position) from the playhead or the clip start
                        if (e.detail === 0) onClip(c.layerId);
                        else
                          onClip(
                            c.layerId,
                            Math.min(Math.max(timeAt(e.clientX), c.startMs), c.endMs - 250),
                          );
                      }}
                    >
                      {(w / 100) * width > 96 ? c.name : ''}
                    </button>
                    {on && (w / 100) * width <= 96 && (
                      <span className="seg-lbl" style={{ left: `calc(${left + w}% + 4px)` }}>
                        {c.name}
                      </span>
                    )}
                    {c.keys?.map((k, i) => (
                      <KeyframeDiamond
                        // keyed by index: a drag moves the key time live, and a remount would drop the drag
                        key={i}
                        layerId={c.layerId}
                        index={i}
                        name={c.name}
                        style={{ left: `${x(k)}%` }}
                        timeAt={timeAt}
                        onKeyframe={onKeyframe}
                        onKeyframeMove={onKeyframeMove}
                      />
                    ))}
                  </span>
                );
              })}
            </div>
            <div className="trk">
              {model.issues.length === 0 && (
                <span className="empty">No issues seen in clips or timed photos</span>
              )}
              {model.issues.map((m) => (
                <button
                  key={m.issueId}
                  type="button"
                  data-hit
                  className={`dia${m.issueId === selectedIssue ? ' sel' : ''}`}
                  style={{ left: pct(m.tMs), ...(m.color ? { background: m.color } : {}) }}
                  title={`${m.code}, severity ${String(m.severity)}`}
                  aria-label={`Issue ${m.code}`}
                  onClick={() => {
                    onSeek(m.tMs);
                    onIssue?.(m.issueId);
                  }}
                />
              ))}
            </div>
            {model.photos.length > 0 && (
              <div className="trk">
                {model.photos.map((p) => (
                  <i
                    key={`${p.layerId}/${p.photoId}`}
                    className="tick"
                    style={{ left: pct(p.tMs) }}
                  />
                ))}
              </div>
            )}
            <div className="trk">
              {model.captures.map((c) => (
                <i key={c.id} className="cap" style={{ left: pct(c.tMs) }} title={c.label} />
              ))}
            </div>
            <div className="playhead" style={{ left: pct(nowMs) }} data-testid="playhead" />
          </div>
        </div>
      ) : (
        <div className="tl-empty">
          <Icon name="clock" size={14} />
          Nothing in this project carries time yet. Clips, timed photos and captures appear here.
        </div>
      )}
    </div>
  );
}
