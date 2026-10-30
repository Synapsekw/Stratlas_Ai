/**
 * The bottom strip (D1, D4): the docked video tile at its start, then the mode switch and the
 * strip it picks (dates, footage, volume over time, chainage). The tile pops out to a floating
 * window over the stage (`SpikeFloatingVideo`), movable and resizable, and pops back in. The
 * strip folds to a 32 px row.
 */
import { formatDate, Icon, IconButton, neighbourClip, t, Timeline, useT } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { clock, useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { ChainageRuler } from '../road/ChainageRuler';
import { DatesStrip } from '../workspace/dates/DatesStrip';
import { pickClip, selectClip } from '../workspace/pickClip';
import { timelineActions, useTimelineBinding } from '../workspace/timelineBinding';
import { stripModes, type ProjectData, type StripMode } from './model';
import { spike, useSpike, type FloatRect } from './spikeStore';

/** The clip the tile shows: the active one, else the project's first video. */
export function useTileClip(): { id: string; name: string } | null {
  const id = useWorkspace((s) => {
    const layers = s.project?.manifest.layers ?? [];
    const v =
      layers.find((l) => l.id === s.activeClip && l.kind === 'video') ??
      layers.find((l) => l.kind === 'video');
    return v?.id ?? null;
  });
  const name = useWorkspace((s) => s.project?.manifest.layers.find((l) => l.id === id)?.name ?? '');
  return useMemo(() => (id ? { id, name } : null), [id, name]);
}

function PlayPause() {
  const playing = useWorkspace((s) => s.playing);
  return (
    <IconButton
      icon={playing ? 'pause' : 'play'}
      label={playing ? t('layoutSpike.video.pause') : t('layoutSpike.video.play')}
      onClick={() => {
        const ws = workspace.getState();
        if (ws.playing) ws.pause();
        else ws.play();
      }}
    />
  );
}

/** The docked tile: 16:9, as tall as the strip less 8 px, with Play, Pop out and Close. */
function VideoTile({ clip }: { clip: { id: string; name: string } }) {
  return (
    <figure
      className="spk-tile"
      aria-label={t('layoutSpike.video.tile', { name: clip.name })}
      data-testid="spike-video-tile"
    >
      <div className="spk-tile-frame">
        <VideoWindow layerId={clip.id} className="scene-fill" />
      </div>
      <div className="spk-tile-bar">
        <PlayPause />
        <IconButton
          icon="maximize"
          label={t('layoutSpike.video.popOut')}
          data-testid="spike-video-popout"
          onClick={() => {
            spike.getState().setVideo('floating');
          }}
        />
        <IconButton
          icon="x"
          label={t('layoutSpike.video.close')}
          onClick={() => {
            spike.getState().setVideo('closed');
          }}
        />
      </div>
    </figure>
  );
}

const MIN_W = 320;
/** First placed top-left, under the island's row and clear of the top-right slot (D4). */
const FIRST_PLACE: FloatRect = { x: 12, y: 64, w: 340 };
const ASPECT = 9 / 16;

/** The window inside the stage: at least 320 x 180, at most 80 % of the stage, aspect kept. */
export function clampFloat(r: FloatRect, stage: { width: number; height: number }): FloatRect {
  const maxW = Math.max(MIN_W, Math.min(stage.width * 0.8, (stage.height * 0.8) / ASPECT));
  const w = Math.round(Math.min(maxW, Math.max(MIN_W, r.w)));
  const h = Math.round(w * ASPECT) + 32;
  const x = Math.round(Math.min(Math.max(0, r.x), Math.max(0, stage.width - w)));
  const y = Math.round(Math.min(Math.max(0, r.y), Math.max(0, stage.height - h)));
  return { x, y, w };
}

/** The popped-out window over the stage: drag the bar to move, a corner to resize, Pop in. */
export function SpikeFloatingVideo({
  clip,
  stageRef,
}: {
  clip: { id: string; name: string };
  stageRef: RefObject<HTMLElement | null>;
}) {
  useT();
  const saved = useSpike((s) => s.rect);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [stageRef]);
  const g = useRef<{
    id: number;
    x: number;
    y: number;
    r: FloatRect;
    corner: string | null;
  } | null>(null);
  if (!size) return null;
  const rect = clampFloat(saved ?? FIRST_PLACE, size);
  const begin = (e: ReactPointerEvent<HTMLElement>, corner: string | null) => {
    if (e.button !== 0) return;
    if (corner === null && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, r: rect, corner };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const s = g.current;
    if (s?.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    let next: FloatRect;
    if (s.corner === null) next = { ...s.r, x: s.r.x + dx, y: s.r.y + dy };
    else {
      const grow = s.corner.includes('e') ? dx : -dx;
      const w = s.r.w + grow;
      next = {
        w,
        x: s.corner.includes('w') ? s.r.x + s.r.w - w : s.r.x,
        y: s.corner.includes('n') ? s.r.y - (w - s.r.w) * ASPECT : s.r.y,
      };
    }
    spike.getState().setRect(clampFloat(next, size));
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (g.current?.id === e.pointerId) g.current = null;
  };
  return (
    <section
      className="spk-float"
      style={{ left: rect.x, top: rect.y, width: rect.w }}
      aria-label={t('layoutSpike.video.tile', { name: clip.name })}
      data-testid="spike-video-float"
    >
      <div
        className="spk-float-bar"
        onPointerDown={(e) => {
          begin(e, null);
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        data-testid="spike-video-float-bar"
      >
        <Icon name="grip" size={14} className="muted" />
        <span className="spk-tile-name">{clip.name}</span>
        <PlayPause />
        <IconButton
          icon="split"
          label={t('layoutSpike.video.popIn')}
          data-testid="spike-video-popin"
          onClick={() => {
            spike.getState().setVideo('docked');
          }}
        />
        <IconButton
          icon="x"
          label={t('layoutSpike.video.close')}
          onClick={() => {
            spike.getState().setVideo('closed');
          }}
        />
      </div>
      <div className="spk-float-frame">
        <VideoWindow layerId={clip.id} className="scene-fill" />
      </div>
      {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
        <div
          key={c}
          className="spk-float-rs"
          data-corner={c}
          aria-hidden="true"
          onPointerDown={(e) => {
            begin(e, c);
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </section>
  );
}

/** The footage timeline, as the Scene's bottom slot shows it today. */
function Footage() {
  const { project, playing, rate, activeClip, selectedIssue, model } = useTimelineBinding();
  const capture = project?.manifest.captures.at(-1);
  const onClip = useCallback(
    (id: string, atMs?: number) => {
      pickClip(
        id,
        atMs,
        model?.clips.find((c) => c.layerId === id),
      );
    },
    [model],
  );
  const onStep = useCallback(
    (dir: 1 | -1) => {
      if (!model) return;
      const c = neighbourClip(model, workspace.getState().activeClip, dir);
      if (!c) return;
      selectClip(c.layerId);
      workspace.getState().setTime(c.startMs);
    },
    [model],
  );
  if (!model) return null;
  return (
    <Timeline
      {...timelineActions}
      className="ws-tl"
      model={model}
      clock={clock}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selectedIssue}
      context={`${capture ? `${formatDate(capture.date)} · ` : ''}UTC`}
      onClip={onClip}
      onStep={onStep}
    />
  );
}

const MODE_ICON = {
  dates: 'calendar',
  footage: 'video',
  volume: 'pile',
  chainage: 'road',
} as const;

export function SpikeBottomStrip({ data, mode }: { data: ProjectData; mode: StripMode }) {
  useT();
  const folded = useSpike((s) => s.stripFolded);
  const video = useSpike((s) => s.video);
  const clip = useTileClip();
  const modes = stripModes(data);
  return (
    <div
      className="spk-strip"
      data-mode={mode}
      data-folded={folded ? '' : undefined}
      aria-label={t('layoutSpike.strip')}
      role="region"
      data-testid="spike-strip"
    >
      {!folded && clip && video === 'docked' && <VideoTile clip={clip} />}
      <div className="spk-strip-modes" role="group" aria-label={t('layoutSpike.strip')}>
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            className="spk-strip-mode"
            aria-pressed={mode === m}
            data-testid={`spike-strip-${m}`}
            onClick={() => {
              spike.getState().setStrip(m);
            }}
          >
            <Icon name={MODE_ICON[m]} size={14} />
            <span>{t(`layoutSpike.strip.${m}`)}</span>
          </button>
        ))}
        {clip && video === 'closed' && (
          <button
            type="button"
            className="spk-strip-mode"
            data-testid="spike-video-reopen"
            onClick={() => {
              spike.getState().setVideo('docked');
            }}
          >
            <Icon name="video" size={14} />
            <span>{t('layoutSpike.video.reopen')}</span>
          </button>
        )}
        <span className="spk-strip-fill" />
        <IconButton
          icon={folded ? 'chevup' : 'chevdown'}
          label={folded ? t('layoutSpike.strip.expand') : t('layoutSpike.strip.collapse')}
          onClick={() => {
            spike.getState().foldStrip(!folded);
          }}
        />
      </div>
      {!folded && (
        <div className="spk-strip-body">
          {mode === 'chainage' ? (
            <ChainageRuler />
          ) : mode === 'footage' ? (
            <Footage />
          ) : data.dates2 || data.piles ? (
            <DatesStrip />
          ) : (
            <p className="spk-strip-empty muted">{t('layoutSpike.strip.empty')}</p>
          )}
        </div>
      )}
    </div>
  );
}
