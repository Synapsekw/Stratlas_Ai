import { PhotoViewer } from '@aio/annotate';
import type { AssetRef, Layer } from '@aio/schema';
import {
  formatClock,
  formatCount,
  formatDate,
  formatDuration,
  Icon,
  shortcutHint,
  useT,
} from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadDetections, useDetections } from '../detections/store';
import { FocusZone } from '../FocusZone';
import { IssueCard } from '../issueCard/IssueCard';
import { Mark } from '../issueCard/Marks';
import { useMedia } from '../media';
import { shell } from '../shell';
import { selectClip } from '../shell/Sidebar';
import { photoSize } from '../thumbs/photoSize';
import { MediaThumb } from '../thumbs/Thumb';
import {
  findingsIndex,
  orderPhotos,
  photoKey,
  shapesInPhoto,
  type PhotoFindings,
  type PhotoOrder,
} from './mediaFindings';
import { flightCards, flightOf, type FlightCard } from './mediaModel';
import { NoProject } from './NoProject';

const PHOTO_LIMIT = 600;

/** "Flight 101 · Shell pass 1 · clip 3 of 7" reads "clip 3 of 7" under its flight. */
function clipLabel(name: string, flight: string): string {
  const rest = name.startsWith(flight) ? name.slice(flight.length).replace(/^[\s·:,|/-]+/, '') : '';
  return rest || name;
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
          <MediaThumb projectId={projectId} asset={flight.poster} icon="video" thumb={false} />
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

/** The findings of a photo drawn over its thumbnail (object-fit cover), once its size is read. */
function FindingsOverlay({
  projectId,
  asset,
  findings,
}: {
  projectId: string;
  asset: AssetRef;
  findings: PhotoFindings;
}) {
  const [size, setSize] = useState<{ asset: AssetRef; wh: [number, number] | null } | null>(null);
  useEffect(() => {
    let url: string;
    try {
      url = assetUrl(projectId, asset);
    } catch {
      return;
    }
    let live = true;
    void photoSize(url).then((wh) => {
      if (live) setSize({ asset, wh });
    });
    return () => {
      live = false;
    };
  }, [projectId, asset]);
  const wh = size?.asset === asset ? size.wh : null;
  if (!wh || findings.shapes.length === 0) return null;
  const shapes = shapesInPhoto(findings.shapes, wh);
  return (
    <svg
      className="m-marks"
      viewBox={`0 0 ${String(wh[0])} ${String(wh[1])}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {shapes.map((sh, i) => (
        <Mark
          key={i}
          geom={sh.geom}
          color={sh.color}
          pointR={Math.max(wh[0], wh[1]) / 30}
          className={`mk${sh.draft ? ' draft' : ''}`}
        />
      ))}
    </svg>
  );
}

/** Count and worst severity of a photo's findings, in the tile corner. */
function FindingsBadge({ findings }: { findings: PhotoFindings }) {
  return (
    <span
      className="m-fbadge mono"
      style={{ ['--c' as string]: findings.color }}
      aria-hidden="true"
    >
      <i />
      {findings.count}
    </span>
  );
}

/** Findings per photo of the open project: issues on photos and detections of the review. */
function usePhotoFindings(projectId: string | null): ReadonlyMap<string, PhotoFindings> {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const detections = useDetections((s) => (s.projectId === projectId ? s.review.detections : null));
  useEffect(() => {
    if (projectId) void loadDetections(projectId);
  }, [projectId]);
  return useMemo(
    () =>
      project
        ? findingsIndex(project.manifest, issues, detections ?? [])
        : new Map<string, never>(),
    [project, issues, detections],
  );
}

/** The filter and order stay while the app runs. */
let rememberedOnly = false;
let rememberedOrder: PhotoOrder = 'file';

export function MediaScreen() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const findings = usePhotoFindings(project?.id ?? null);
  const [onlyFindings, setOnlyFindings] = useState(rememberedOnly);
  const [order, setOrder] = useState<PhotoOrder>(rememberedOrder);
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
  const issueId = selection?.kind === 'issue' ? selection.id : null;
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
  const withFindings = photoSets.reduce(
    (n, set) => n + set.items.filter((p) => findings.has(photoKey(set.id, p.id))).length,
    0,
  );

  return (
    <section className={`screen media${photo || issueId ? ' with-viewer' : ''}`} aria-label="Media">
      <div className="media-main" ref={photoRef} data-thumb-root>
        <header className="page-h">
          <h1>Media</h1>
          <p className="muted">
            {formatCount(clips.length)} clips ·{' '}
            {formatCount(photoSets.reduce((n, l) => n + l.items.length, 0))} photos ·{' '}
            {formatCount(panoSets.reduce((n, l) => n + l.items.length, 0))} panoramas
          </p>
          {photoSets.length > 0 && (
            <div className="m-tools" role="group" aria-label={t('media.findings.tools')}>
              <span
                className={`m-fsum${withFindings > 0 ? ' on' : ''}`}
                data-testid="media-findings-count"
              >
                <i />
                {t('media.findings.summary', { count: withFindings })}
              </span>
              <button
                type="button"
                className="btn sm"
                aria-pressed={onlyFindings}
                data-testid="media-only-findings"
                disabled={withFindings === 0 && !onlyFindings}
                onClick={() => {
                  rememberedOnly = !onlyFindings;
                  setOnlyFindings(rememberedOnly);
                }}
              >
                <Icon name="filter" size={14} />
                {t('media.findings.only')}
              </button>
              <label className="m-order">
                <span>{t('media.findings.sort')}</span>
                <select
                  className="input sm"
                  value={order}
                  data-testid="media-order"
                  onChange={(e) => {
                    rememberedOrder = e.target.value as PhotoOrder;
                    setOrder(rememberedOrder);
                  }}
                >
                  <option value="file">{t('media.findings.sort.file')}</option>
                  <option value="severity">{t('media.findings.sort.severity')}</option>
                  <option value="count">{t('media.findings.sort.count')}</option>
                </select>
              </label>
            </div>
          )}
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
                    <MediaThumb
                      projectId={project.id}
                      asset={c.poster}
                      icon="video"
                      thumb={false}
                    />
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
        {photoSets.map((set) => {
          const items = orderPhotos(set.items, set.id, findings, onlyFindings, order);
          if (onlyFindings && items.length === 0) return null;
          return (
            <section className="m-sec" key={set.id}>
              <h2 className="caps">
                {set.name}{' '}
                <span className="mono faint">
                  {onlyFindings
                    ? `${formatCount(items.length)} / ${formatCount(set.items.length)}`
                    : formatCount(set.items.length)}
                </span>
              </h2>
              <div className="m-grid">
                {items.slice(0, PHOTO_LIMIT).map((p) => {
                  const f = findings.get(photoKey(set.id, p.id));
                  const on = photo?.photoId === p.id && photo.layerId === set.id;
                  const when = p.takenAt ? ` · ${formatDate(p.takenAt)}` : '';
                  const what = f
                    ? ` · ${f.label ? t('media.findings.tile', { count: f.count, severity: f.label }) : t('media.findings.tileUngraded', { count: f.count })}`
                    : '';
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-photo={p.id}
                      data-findings={f ? f.count : undefined}
                      className={`m-card sq${on ? ' on' : ''}${f ? ' has-f' : ''}`}
                      style={f ? { ['--c' as string]: f.color } : undefined}
                      onClick={() => {
                        workspace.getState().select({ kind: 'photo', id: p.id, layer: set.id });
                      }}
                      title={`${p.id}${when}${what}`}
                      aria-label={`${p.id}${what}`}
                    >
                      <MediaThumb
                        projectId={project.id}
                        asset={p.src}
                        icon="photo"
                        overlay={
                          f ? (
                            <FindingsOverlay projectId={project.id} asset={p.src} findings={f} />
                          ) : undefined
                        }
                      />
                      {f && <FindingsBadge findings={f} />}
                    </button>
                  );
                })}
              </div>
              {items.length > PHOTO_LIMIT && (
                <p className="faint small">
                  {t('media.photoLimit', {
                    limit: PHOTO_LIMIT,
                    total: formatCount(items.length),
                    keys: shortcutHint('global.palette'),
                  })}
                </p>
              )}
            </section>
          );
        })}
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
                  <MediaThumb projectId={project.id} asset={p.src} icon="pano" />
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
      {issueId && !photo && (
        <aside className="media-viewer media-card" aria-label={t('card.title')}>
          <IssueCard issueId={issueId} place="media" className="fill-col" />
        </aside>
      )}
      {photo && (
        <FocusZone kind="photo" className="media-viewer" aria-label="Photo">
          <div className="panel-h">
            <h2>
              <Icon name="photo" size={14} />
              {photo.photoId}
            </h2>
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
