/**
 * The Video and camera workbench (stage island D12): the active clip as a player card on top,
 * then the clip list, the camera views, the flight paths and the telemetry. The card is a poster
 * and a scrubber that move the project clock; the one floating video window plays that clock, so
 * there is no second decoder here.
 */
import { Button, flightGroups, Icon, IconButton, Row, Switch, useT } from '@aio/ui';
import { telemetryAt } from '@aio/video';
import { assetUrl, clipStartMs, useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useMedia } from '../../../media';
import { shell, useShell } from '../../../shell';
import { useFlightPathModel } from '../../pathModel';
import { selectClip } from '../../pickClip';
import { useEngineStage } from '../../StageTools';
import { toggleTelemetry, useTelemetryOn } from '../../telemetryPref';
import { FlightPathPanel, useCameraModes } from '../../tools/video';
import { Section } from '../Section';
import './benches.css';

/** "1:05" for a time in milliseconds. */
function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

/** The poster's address; none when the clip has no poster or its path is not allowed. */
function posterUrl(projectId: string, src: Parameters<typeof assetUrl>[1] | undefined) {
  if (!src) return null;
  try {
    return assetUrl(projectId, src);
  } catch {
    return null;
  }
}

/** The active clip's poster, or a stand-in when it has none. No video element: see the head. */
function Poster({
  projectId,
  src,
}: {
  projectId: string;
  src: Parameters<typeof assetUrl>[1] | undefined;
}) {
  const url = posterUrl(projectId, src);
  return (
    <div className="vb-poster-box">
      {url ? (
        <img className="vb-poster" src={url} alt="" draggable={false} />
      ) : (
        <Icon name="video" size={20} />
      )}
    </div>
  );
}

/** Poster, play and pause, window toggle and the scrubber of the active clip. */
function PlayerCard() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const videoHidden = useShell((s) => s.videoHidden);
  const { durations, flights } = useMedia(project);
  const layer = project?.manifest.layers.find((l) => l.id === activeClip);
  if (!project || layer?.kind !== 'video') {
    return <p className="vb-pick">{t('bench.video.pick')}</p>;
  }
  const start = clipStartMs(layer);
  const length = durations[layer.id];
  const at = length === undefined ? 0 : Math.min(length, Math.max(0, nowMs - start));
  const samples = flights[layer.id];
  const tm = samples?.length ? telemetryAt(samples, nowMs - layer.flight.startUtcMs) : null;
  return (
    <div className="vb-card" data-testid="player-card">
      <Poster projectId={project.id} src={layer.poster} />
      <div className="vb-name">{layer.name}</div>
      <input
        className="vb-scrub"
        type="range"
        min={0}
        max={length ?? 1}
        step={100}
        value={at}
        disabled={length === undefined}
        aria-label={t('bench.video.playhead')}
        aria-valuetext={length === undefined ? undefined : `${clock(at)} / ${clock(length)}`}
        onChange={(e) => {
          workspace.getState().setTime(start + Number(e.currentTarget.value));
        }}
      />
      <div className="vb-bar">
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? t('bench.video.pause') : t('bench.video.play')}
          shortcut="global.playPause"
          onClick={() => {
            if (playing) workspace.getState().pause();
            else workspace.getState().play();
          }}
        />
        <span className="vb-time mono">
          {clock(at)}
          {length !== undefined && ` / ${clock(length)}`}
        </span>
        {tm && (
          <span className="vb-tele mono">
            {t('island.telemetry', {
              alt: Math.round(tm.altitudeM),
              speed: tm.speedMps.toFixed(1),
            })}
          </span>
        )}
        <IconButton
          icon="video"
          label={videoHidden ? t('island.tile.showVideo') : t('island.tile.hideVideo')}
          shortcut="scene.video"
          pressed={!videoHidden}
          onClick={() => {
            shell.getState().setVideoHidden(!videoHidden);
          }}
        />
      </div>
    </div>
  );
}

/** The project's clips by flight; a click makes one the active clip. */
function ClipList() {
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const { durations } = useMedia(project);
  const groups = useMemo(() => flightGroups(project?.manifest.layers ?? []), [project]);
  return (
    <div className="vb-clips">
      {groups.map((g) => (
        <div key={g.id} className="vb-flight" role="group" aria-label={g.name}>
          <div className="vb-flight-name">{g.name}</div>
          {g.clips.map((c) => {
            const length = durations[c.id];
            return (
              <Row
                key={c.id}
                as="button"
                kind="tree"
                icon="video"
                label={c.name}
                selected={c.id === activeClip}
                aria-current={c.id === activeClip ? 'true' : undefined}
                data-clip={c.id}
                {...(length === undefined ? {} : { count: clock(length) })}
                onClick={() => {
                  selectClip(c.id);
                  const ws = workspace.getState();
                  const begin = clipStartMs(c);
                  if (ws.nowMs < begin || (length !== undefined && ws.nowMs > begin + length))
                    ws.setTime(begin);
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Free orbit, follow the drone and the drone's own eye. */
function CameraModes() {
  const t = useT();
  const modes = useCameraModes(useEngineStage());
  return (
    <div className="vb-modes" role="group" aria-label={t('bench.video.camera')}>
      {modes.map((m) => (
        <Button
          key={m.mode}
          variant="quiet"
          size="md"
          className="vb-mode"
          icon={m.icon}
          pressed={m.pressed}
          disabled={m.disabled}
          onClick={m.choose}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}

export function VideoBench() {
  const t = useT();
  const paths = useFlightPathModel();
  const telemetry = useTelemetryOn();
  const clips = useWorkspace(
    (s) => s.project?.manifest.layers.filter((l) => l.kind === 'video').length ?? 0,
  );
  return (
    <div className="vb wb-scroll">
      <h2 className="vb-title">{t('bench.video.heading')}</h2>
      <PlayerCard />
      <Section
        id="video-clips"
        bench="video"
        title={t('bench.video.clips')}
        count={clips}
        defaultOpen
      >
        <ClipList />
      </Section>
      <Section id="video-camera" bench="video" title={t('bench.video.camera')} defaultOpen>
        <CameraModes />
      </Section>
      {paths && (
        <Section id="video-paths" bench="video" title={t('bench.video.paths')} defaultOpen>
          <FlightPathPanel showTitle={false} />
        </Section>
      )}
      <Section id="video-telemetry" bench="video" title={t('bench.video.telemetry')} defaultOpen>
        <div className="vb-switch">
          <span>{t('bench.video.telemetryOn')}</span>
          <Switch
            checked={telemetry}
            label={t('bench.video.telemetryOn')}
            onChange={() => {
              toggleTelemetry();
            }}
          />
        </div>
      </Section>
    </div>
  );
}
