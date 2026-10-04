import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { formatClock, formatCount } from '../format';
import { t } from '../i18n';
import { Icon } from '../icons/Icon';
import type { TimelineModel } from './model';
import { generateTicks, pickTickStep } from './ticks';

export const RATES = [0.25, 0.5, 1, 2, 4, 8] as const;

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
  /** A clip was chosen; `atMs` is the clicked time when the click landed on a flight bar. */
  onClip: (layerId: string, atMs?: number) => void;
  onIssue?: (issueId: string) => void;
  onStep: (dir: 1 | -1) => void;
  /** Right-aligned context line, e.g. capture date and time base. */
  context?: ReactNode;
  /** Collapse the timeline (a button at the end of the header); `hideKeys` names its shortcut. */
  onHide?: () => void;
  hideKeys?: string;
  className?: string;
}

const MIN_SPAN = 2_000;
/** Below this average clip width (px) a flight's clips draw as one bar. */
const GROUP_BELOW_PX = 28;

function tickLabel(t: number, major: number): string {
  const d = new Date(t);
  if (major >= 86_400_000) return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  const clock = formatClock(t);
  if (major >= 60_000) return clock.slice(0, 5);
  if (major >= 1_000) return clock;
  return `${clock}.${String(d.getUTCMilliseconds()).padStart(3, '0').slice(0, 1)}`;
}

/**
 * Mission timeline: transport, ruler, a clips track, issue diamonds, timed photos and captures,
 * and a playhead. Purely presentational; bind it to a store with props.
 */
export function Timeline(props: TimelineProps) {
  const { model, nowMs, playing, rate, activeClip, selectedIssue } = props;
  const { onSeek, onTogglePlay, onRate, onClip, onIssue, onStep } = props;
  const tracksRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const hasTime = model.range !== null;
  const rangeKey = model.range ? `${model.range[0]}:${model.range[1]}` : 'none';
  const [manual, setManual] = useState<{ key: string; view: [number, number] } | null>(null);
  // A new project or new clip durations reset the view to fit.
  const view = manual?.key === rangeKey ? manual.view : model.range;
  const setView = useCallback(
    (v: [number, number] | null) => {
      setManual(v ? { key: rangeKey, view: v } : null);
    },
    [rangeKey],
  );
  // Keep the playhead in view while playing (state adjusted during render, no effect needed).
  if (playing && view && (nowMs > view[1] || nowMs < view[0])) {
    const s = view[1] - view[0];
    setManual({ key: rangeKey, view: [nowMs - s * 0.1, nowMs + s * 0.9] });
  }

  useLayoutEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(1, entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.max(1, el.clientWidth));
    return () => {
      ro.disconnect();
    };
  }, [hasTime]);

  const [v0, v1] = view ?? [0, 1];
  const span = Math.max(v1 - v0, 1);
  const x = useCallback((t: number) => ((t - v0) / span) * 100, [v0, span]);
  const pct = (t: number) => `${x(t).toFixed(3)}%`;

  const step = useMemo(() => pickTickStep(span, width), [span, width]);
  const ticks = useMemo(() => generateTicks(v0, v1, step), [v0, v1, step]);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = tracksRef.current;
      if (!el) return v0;
      const r = el.getBoundingClientRect();
      return v0 + ((clientX - r.left) / Math.max(r.width, 1)) * span;
    },
    [v0, span],
  );

  const zoom = useCallback(
    (factor: number, anchor: number) => {
      if (!view) return;
      const [a, b] = view;
      const next = Math.max(MIN_SPAN, (b - a) * factor);
      const f = (anchor - a) / (b - a);
      setView([anchor - next * f, anchor + next * (1 - f)]);
    },
    [view, setView],
  );

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

  // Ctrl + wheel zooms at the cursor, wheel pans. Registered natively to allow preventDefault.
  useEffect(() => {
    const el = tracksRef.current;
    if (!el || !view) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e.clientX));
      } else {
        const d = ((e.deltaX || e.deltaY) / Math.max(width, 1)) * span;
        setView([v0 + d, v1 + d]);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [view, setView, zoom, timeAt, width, span, v0, v1]);

  const frames = String(Math.floor(((((nowMs % 1000) + 1000) % 1000) / 1000) * 30)).padStart(
    2,
    '0',
  );
  const nextRate = () => {
    const i = RATES.findIndex((r) => r === rate);
    onRate(RATES[(i + 1) % RATES.length] ?? 1);
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
        <div className="transport">
          <button
            className="tool tip-up"
            type="button"
            onClick={() => {
              onStep(-1);
            }}
            disabled={model.clips.length === 0}
            aria-label="Previous clip"
          >
            <Icon name="back" />
            <span className="tip">Previous clip</span>
          </button>
          <button
            className="tool play"
            type="button"
            onClick={onTogglePlay}
            disabled={!hasTime}
            aria-label={playing ? 'Pause' : 'Play'}
            aria-keyshortcuts="Space"
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button
            className="tool tip-up"
            type="button"
            onClick={() => {
              onStep(1);
            }}
            disabled={model.clips.length === 0}
            aria-label="Next clip"
          >
            <Icon name="fwd" />
            <span className="tip">Next clip</span>
          </button>
        </div>
        <div className="tc" data-testid="timecode">
          {hasTime ? (
            <>
              {formatClock(nowMs)}
              <small>.{frames}</small>
            </>
          ) : (
            '--:--:--'
          )}
        </div>
        <button
          className="rate"
          type="button"
          onClick={nextRate}
          title="Playback rate"
          aria-label={`Playback rate ${rate}x`}
        >
          {rate.toFixed(rate < 1 ? 2 : 1)}×
        </button>
        {active && (
          <span className="tag">
            <Icon name="video" size={12} />
            {active.name}
          </span>
        )}
        <span className="sp" />
        {props.context && <span className="ctx">{props.context}</span>}
        <div className="seg icons" role="group" aria-label="Timeline zoom">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (Ctrl + wheel)"
            onClick={() => {
              zoom(1.6, nowMs);
            }}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            aria-label="Fit"
            title="Fit everything"
            onClick={() => {
              setView(model.range);
            }}
          >
            <Icon name="maximize" size={14} />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (Ctrl + wheel)"
            onClick={() => {
              zoom(0.625, nowMs);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {props.onHide && (
          <button
            className="tool tip-up tl-hide"
            type="button"
            onClick={props.onHide}
            aria-label={t('timeline.hide')}
            aria-keyshortcuts={props.hideKeys}
          >
            <Icon name="chevdown" />
            <span className="tip tip-end">
              {t('timeline.hide')}
              {props.hideKeys && <span className="kbd">{props.hideKeys}</span>}
            </span>
          </button>
        )}
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
            <div className="tl-ruler" aria-hidden="true">
              {ticks.map((tk) => (
                <span key={tk.t}>
                  <i className={`tk ${tk.major ? 'maj' : 'min'}`} style={{ left: pct(tk.t) }} />
                  {tk.major && (
                    <span className="tkl" style={{ left: pct(tk.t) }}>
                      {tickLabel(tk.t, step.major)}
                    </span>
                  )}
                </span>
              ))}
            </div>
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
                      onClick={() => {
                        onClip(c.layerId);
                      }}
                    >
                      {(w / 100) * width > 96 ? c.name : ''}
                    </button>
                    {on && (w / 100) * width <= 96 && (
                      <span className="seg-lbl" style={{ left: `calc(${left + w}% + 4px)` }}>
                        {c.name}
                      </span>
                    )}
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
