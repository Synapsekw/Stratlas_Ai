import { PhotoViewer } from '@aio/annotate';
import type { AssetRef, Layer } from '@aio/schema';
import { formatClock, formatCount, formatDate, formatDuration, Icon } from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useState } from 'react';
import { FocusZone } from '../FocusZone';
import { useMedia } from '../media';
import { shell } from '../shell';
import { selectClip } from '../shell/Sidebar';
import { NoProject } from './NoProject';

const PHOTO_LIMIT = 240;

function safeUrl(projectId: string, ref: AssetRef | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return assetUrl(projectId, ref);
  } catch {
    return undefined;
  }
}

function Poster({ src, icon }: { src: string | undefined; icon: 'video' | 'photo' | 'pano' }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="m-thumb">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <Icon name={icon} size={20} />
      )}
    </div>
  );
}

export function MediaScreen() {
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const { durations } = useMedia(project);
  const [photo, setPhoto] = useState<{ layerId: string; photoId: string } | null>(null);
  if (!project) return <NoProject view="Media" />;

  const layers = project.manifest.layers;
  const clips = layers.filter((l): l is Extract<Layer, { kind: 'video' }> => l.kind === 'video');
  const photoSets = layers.filter(
    (l): l is Extract<Layer, { kind: 'photos' }> => l.kind === 'photos',
  );
  const panoSets = layers.filter(
    (l): l is Extract<Layer, { kind: 'panoramas' }> => l.kind === 'panoramas',
  );
  const empty = clips.length + photoSets.length + panoSets.length === 0;

  return (
    <section className={`screen media${photo ? ' with-viewer' : ''}`} aria-label="Media">
      <div className="media-main">
        <header className="page-h">
          <h1>Media</h1>
          <p className="muted">
            {formatCount(clips.length)} clips ·{' '}
            {formatCount(photoSets.reduce((n, l) => n + l.items.length, 0))} photos ·{' '}
            {formatCount(panoSets.reduce((n, l) => n + l.items.length, 0))} panoramas
          </p>
        </header>
        {empty && (
          <div className="side-empty">
            <Icon name="media" size={20} />
            <p>This project has no video, photos or panoramas.</p>
          </div>
        )}
        {clips.length > 0 && (
          <section className="m-sec">
            <h2 className="caps">Video clips</h2>
            <div className="m-grid wide">
              {clips.map((c) => {
                const start = c.flight.startUtcMs + c.offsetMs;
                const d = durations[c.id];
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`m-card${c.id === activeClip ? ' on' : ''}`}
                    onClick={() => {
                      selectClip(c.id);
                      workspace.getState().setTime(start);
                      shell.getState().go('scene');
                    }}
                  >
                    <Poster src={safeUrl(project.id, c.poster)} icon="video" />
                    <div className="m-meta">
                      <b>{c.name}</b>
                      <span className="mono">
                        {formatClock(start)} UTC{d !== undefined ? ` · ${formatDuration(d)}` : ''}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {photoSets.map((set) => (
          <section className="m-sec" key={set.id}>
            <h2 className="caps">
              {set.name} <span className="mono faint">{formatCount(set.items.length)}</span>
            </h2>
            <div className="m-grid">
              {set.items.slice(0, PHOTO_LIMIT).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`m-card sq${photo?.photoId === p.id && photo.layerId === set.id ? ' on' : ''}`}
                  onClick={() => {
                    setPhoto({ layerId: set.id, photoId: p.id });
                    workspace.getState().select({ kind: 'photo', id: p.id, layer: set.id });
                  }}
                  title={p.takenAt ? `${p.id} · ${formatDate(p.takenAt)}` : p.id}
                >
                  <Poster src={safeUrl(project.id, p.src)} icon="photo" />
                </button>
              ))}
            </div>
            {set.items.length > PHOTO_LIMIT && (
              <p className="faint small">
                Showing the first {PHOTO_LIMIT} of {formatCount(set.items.length)}. Use Ctrl K to
                find a photo by name.
              </p>
            )}
          </section>
        ))}
        {panoSets.map((set) => (
          <section className="m-sec" key={set.id}>
            <h2 className="caps">
              {set.name} <span className="mono faint">{formatCount(set.items.length)}</span>
            </h2>
            <div className="m-grid wide">
              {set.items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="m-card"
                  onClick={() => {
                    workspace.getState().select({ kind: 'pano', id: p.id, layer: set.id });
                    shell.getState().go('scene');
                  }}
                >
                  <Poster src={safeUrl(project.id, p.src)} icon="pano" />
                  <div className="m-meta">
                    <b>{p.id}</b>
                    <span className="mono">HDG {String(p.headingDeg)}°</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {photo && (
        <FocusZone kind="photo" className="media-viewer" aria-label="Photo">
          <div className="panel-h">
            <h3>
              <Icon name="photo" size={14} />
              {photo.photoId}
            </h3>
            <div className="acts">
              <button
                type="button"
                className="btn icon sm ghost"
                aria-label="Close the photo"
                onClick={() => {
                  setPhoto(null);
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
          <PhotoViewer layerId={photo.layerId} photoId={photo.photoId} className="fill-col" />
        </FocusZone>
      )}
    </section>
  );
}
