/**
 * The video docked at the start of the bottom strip (D4): a 16:9 tile as tall as the strip less
 * 8 px, following the playhead, with Play or Pause, Pop out and Close. Popped out, the clip plays
 * in the floating window over the stage instead (`FloatingVideo`); closed, a slim Show button at
 * the strip's start brings the tile back.
 */
import { IconButton, useT } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, type ReactElement } from 'react';
import { useVideoDock, videoDock } from './videoDockStore';
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

/** The visible control among `ids` inside `root` (the tile hides in a narrow strip). */
function visibleIn(root: HTMLElement | null, ids: readonly string[]): HTMLElement | null {
  for (const id of ids) {
    const el = root?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (el && el.getClientRects().length > 0) return el;
  }
  return null;
}

/**
 * What the strip's start holds for the open project: the tile, the Show button, or nothing. In a
 * strip too narrow for the tile and the bar side by side (both sidebars open at 1100 px), the
 * tile gives way to one Pop out button, so the stage keeps its height (videoDock.css).
 */
export function VideoStripStart({ hidden = false }: { hidden?: boolean }): ReactElement | null {
  const t = useT();
  const dock = useVideoDock();
  const name = useWorkspace(
    (s) => s.project?.manifest.layers.find((l) => l.id === dock.clip)?.name ?? '',
  );
  const root = useRef<HTMLDivElement>(null);
  const shown = !hidden && dock.clip !== null && dock.mode !== 'floating';
  // after Pop in or Close, focus lands on what brings the video back out
  useEffect(() => {
    if (!shown) return;
    const want = videoDock.getState().focus;
    const target =
      want === 'popout' && dock.mode === 'docked'
        ? visibleIn(root.current, ['video-popout', 'video-popout-compact'])
        : want === 'show' && dock.mode === 'closed'
          ? visibleIn(root.current, ['video-show'])
          : null;
    if (!target) return;
    videoDock.getState().takeFocus();
    target.focus();
  }, [shown, dock.mode]);
  if (!shown || dock.clip === null) return null;
  return (
    <div ref={root} className="vdock" data-testid="video-dock" data-mode={dock.mode}>
      {dock.mode === 'closed' ? (
        <div className="vtile-show">
          <IconButton
            icon="video"
            label={t('stage.video.show')}
            data-testid="video-show"
            onClick={dock.reopen}
          />
        </div>
      ) : (
        <>
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
          <div className="vtile-compact">
            <IconButton
              icon="maximize"
              size="sm"
              label={t('stage.video.popOut')}
              data-testid="video-popout-compact"
              onClick={dock.popOut}
            />
          </div>
        </>
      )}
    </div>
  );
}
