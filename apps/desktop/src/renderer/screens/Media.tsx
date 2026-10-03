import { PhotoViewer } from '@aio/annotate';
import type { AssetRef, Layer } from '@aio/schema';
import { formatClock, formatCount, formatDate, formatDuration, Icon } from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FocusZone } from '../FocusZone';
import { useMedia } from '../media';
import { shell } from '../shell';
import { selectClip } from '../shell/Sidebar';
import { flightCards, flightOf, type FlightCard } from './mediaModel';
import { NoProject } from './NoProject';

const PHOTO_LIMIT = 600;

function safeUrl(projectId: string, ref: AssetRef | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return assetUrl(projectId, ref);
  } catch {
    return undefined;
  }
}

/** "Flight 101 · Shell pass 1 · clip 3 of 7" reads "clip 3 of 7" under its flight. */
function clipLabel(name: string, flight: string): string {
  const rest = name.startsWith(flight) ? name.slice(flight.length).replace(/^[\s·:,|/-]+/, '') : '';
  return rest || name;
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

/** Play a clip in the Scene from its start. */
function playClip(c: Extract<Layer, { kind: 'video' }>) {
  selectClip(c.id);
  workspace.getState().setTime(c.flight.startUtcMs + c.offsetMs);
  shell.getState().go('scene');
}

function FlightTile({
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
  const first = flight.clips[0];
  const n = flight.clips.length;
  return (
    <div className={`m-card m-flight${open ? ' on' : ''}`}>
      <button
        type="button"
        className="m-flight-main"
        aria-expanded={open}
        aria-controls="m-flight-clips"
        onClick={onOpen}
      >
        <div className="m-poster">
          <Poster src={safeUrl(projectId, flight.poster)} icon="video" />
          <span className="m-badge mono">
            {flight.estimated ? '~' : ''}
            {formatDuration(flight.endMs - flight.startMs)}
          </span>
          {playing && <span className="m-live">Active</span>}
        </div>
        <div className="m-meta">
          <b>{flight.name}</b>
          <span className="mono">
            {formatClock(flight.startMs)} UTC · {n} {n === 1 ? 'clip' : 'clips'}
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

export function MediaScreen() {
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const { durations } = useMedia(project);
  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const flights = useMemo(() => flightCards(layers, durations), [layers, durations]);
  const [openFlight, setOpenFlight] = useState<string | null>(null);
  const shownFlight = flights.find((f) => f.id === openFlight) ?? flightOf(flights, activeClip);
  // The photo viewer follows the selection: a photo picked here, in 3D or from an issue.
  const photo =
    selection?.kind === 'photo'
      ? {
          layerId: selection.layer ?? layers.find((l) => l.kind === 'photos')?.id ?? 'photos',
          photoId: selection.id,
        }
      : null;
  const photoId = photo?.photoId;
  const photoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!photoId) return;
    photoRef.current
      ?.querySelector(`[data-photo="${CSS.escape(photoId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [photoId]);
  if (!project) return <NoProject view="Media" />;

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
        {flights.length > 0 && (
          <section className="m-sec">
            <h2 className="caps">
              Flights <span className="mono faint">{formatCount(flights.length)}</span>
            </h2>
            <div className="m-grid flights">
              {flights.map((f) => (
                <FlightTile
                  key={f.id}
                  flight={f}
                  projectId={project.id}
                  open={f.id === shownFlight?.id}
                  playing={f.clips.some((c) => c.id === activeClip)}
                  onOpen={() => {
                    setOpenFlight(f.id);
                    requestAnimationFrame(() => {
                      document
                        .getElementById('m-flight-clips')
                        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    });
                  }}
                />
              ))}
            </div>
          </section>
        )}
        {shownFlight && (
          <section
            className="m-sec"
            id="m-flight-clips"
            aria-label={`Clips of ${shownFlight.name}`}
          >
            <h2 className="caps">
              {shownFlight.name}{' '}
              <span className="mono faint">{formatCount(shownFlight.clips.length)} clips</span>
            </h2>
            <div className="m-grid clips">
              {shownFlight.clips.map((c) => {
                const start = c.flight.startUtcMs + c.offsetMs;
                const d = durations[c.id];
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`m-card${c.id === activeClip ? ' on' : ''}`}
                    title={`Play ${c.name} in the scene`}
                    onClick={() => {
                      playClip(c);
                    }}
                  >
                    <Poster src={safeUrl(project.id, c.poster)} icon="video" />
                    <div className="m-meta">
                      <b>{clipLabel(c.name, shownFlight.name)}</b>
                      <span className="mono">
                        {formatClock(start)}
                        {d !== undefined ? ` · ${formatDuration(d)}` : ''}
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
            <div className="m-grid" ref={photoRef}>
              {set.items.slice(0, PHOTO_LIMIT).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-photo={p.id}
                  className={`m-card sq${photo?.photoId === p.id && photo.layerId === set.id ? ' on' : ''}`}
                  onClick={() => {
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
                  workspace.getState().select(null);
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
