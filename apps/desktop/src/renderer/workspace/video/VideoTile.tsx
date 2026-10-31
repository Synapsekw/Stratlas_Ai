/**
 * The video docked at the start of the bottom strip (D4): a 16:9 tile as tall as the strip less
 * 8 px, following the playhead, with Play or Pause, Pop out and Close. Popped out, the clip plays
 * in the floating window over the stage instead (`FloatingVideo`); closed, a slim Show button at
 * the strip's start brings the tile back.
 */
import { IconButton, useT } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import type { ReactElement } from 'react';
import { useVideoDock } from './videoDockStore';
import './videoDock.css';

function PlayPause(): ReactElement {
  const t = useT();
  const playing = useWorkspace((s) => s.playing);
  return (
    <IconButton
      icon={playing ? 'pause' : 'play'}
      size="sm"
      label={playing ? t('stage.video.pause') : t('stage.video.play')}
      onClick={() => {
        const ws = workspace.getState();
        if (ws.playing) ws.pause();
        else ws.play();
      }}
    />
  );
}

/** What the strip's start holds for the open project: the tile, the Show button, or nothing. */
export function VideoStripStart({ hidden = false }: { hidden?: boolean }): ReactElement | null {
  const t = useT();
  const dock = useVideoDock();
  const name = useWorkspace(
    (s) => s.project?.manifest.layers.find((l) => l.id === dock.clip)?.name ?? '',
  );
  if (hidden || dock.clip === null) return null;
  if (dock.mode === 'closed')
    return (
      <div className="vtile-show">
        <IconButton
          icon="video"
          label={t('stage.video.show')}
          data-testid="video-show"
          onClick={dock.reopen}
        />
      </div>
    );
  if (dock.mode !== 'docked') return null;
  return (
    <figure
      className="vtile"
      aria-label={t('stage.video.tile', { name })}
      data-testid="video-tile"
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) dock.popOut();
      }}
    >
      <div className="vtile-frame">
        <VideoWindow layerId={dock.clip} className="scene-fill" />
      </div>
      <div className="vtile-bar">
        <PlayPause />
        <IconButton
          icon="maximize"
          size="sm"
          label={t('stage.video.popOut')}
          data-testid="video-popout"
          onClick={dock.popOut}
        />
        <IconButton icon="x" size="sm" label={t('stage.video.close')} onClick={dock.close} />
      </div>
    </figure>
  );
}
