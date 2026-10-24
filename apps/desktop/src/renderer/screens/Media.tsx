import { PhotoViewer } from '@aio/annotate';
import type { AssetRef, Layer } from '@aio/schema';
import {
  formatClock,
  formatCount,
  formatDate,
  formatDuration,
  Icon,
  shortcutHint,
  useResizableSplit,
  useT,
} from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { loadDetections, useDetections } from '../detections/store';
import { FocusZone } from '../FocusZone';
import { IssueCard } from '../issueCard/IssueCard';
import { Mark } from '../issueCard/Marks';
import { useMedia } from '../media';
import { InlineSpotStrip, SpotHistoryButton } from '../workspace/spot/SpotHistoryEntry';
import { shell } from '../shell';
import { clipLabel, FlightTile, playClip } from '../inspect/FlightTile';
import { photoSize } from '../thumbs/photoSize';
import { MediaThumb } from '../thumbs/Thumb';
import {
  findingsIndex,
  photoKey,
  shapesInPhoto,
  type PhotoFindings,
  type PhotoOrder,
} from './mediaFindings';
import {
  flightCards,
  flightOf,
  isPhotoEdited,
  mediaSummary,
  panoCard,
  showsClipList,
} from './mediaModel';
import {
  noPhotoMatches,
  photosInView,
  setMediaView,
  severityOptions,
  takeMediaReveal,
  useMediaRevealAsked,
  useMediaView,
} from './mediaView';
import { PanoPinChips, PhotoTile, useTileMenu } from './MediaPins';
import { isPicked, mediaPicks, useMediaPicks } from './mediaSelect';
import { NoProject } from './NoProject';
import { PageHeader } from '../shell/PageHeader';

const PHOTO_LIMIT = 600;

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

/**
 * The library and the opened photo (or a finding's card) side by side on the `media.viewer`
 * split: the viewer is 54% of the screen until the person drags the handle between them, and the
 * size is remembered. With nothing open the library has the whole screen and there is no handle.
 */
function useViewerSplit() {
  return useResizableSplit({
    id: 'media.viewer',
    orientation: 'horizontal',
    sized: 'end',
    unit: 'fraction',
    defaultSize: 0.54,
    min: 360,
    max: '80%',
    otherMin: 200,
    // a screen too narrow for both (the agent column open in a small window): the viewer gives
    // way to 60%, as before, so the library keeps room for its tiles
    minShare: 0.6,
  });
}

export function MediaScreen() {
  const t = useT();
  const viewerId = useId();
  const { containerRef: splitRef, separatorProps: splitHandle } = useViewerSplit();
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const findings = usePhotoFindings(project?.id ?? null);
  const view = useMediaView((s) => s);
  const { onlyFindings, order, severity, scope } = view;
  const { durations } = useMedia(project);
  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const flights = useMemo(() => flightCards(layers, durations), [layers, durations]);
  const photoSets = useMemo(
    () => layers.filter((l): l is Extract<Layer, { kind: 'photos' }> => l.kind === 'photos'),
    [layers],
  );
  // a second filter and sort of every photo set: done when the sets, the findings or the view
  // change, not on every render (each selection, each clip duration that is read)
  const noMatch = useMemo(
    () => noPhotoMatches(photoSets, findings, view),
    [photoSets, findings, view],
  );
  const shownSets = useMemo(
    () => photoSets.map((set) => ({ set, items: photosInView(set.items, set.id, findings, view) })),
    [photoSets, findings, view],
  );
  // the photo tiles as shown, in order: a Shift click picks the range between two of them
  const tileOrder = useMemo(
    () =>
      shownSets.flatMap(({ set, items }) =>
        items.slice(0, PHOTO_LIMIT).map((p) => ({ layerId: set.id, photoId: p.id })),
      ),
    [shownSets],
  );
  const orientation = useWorkspace((s) => s.orientation);
  const picks = useMediaPicks((s) => s);
  const [openFlight, setOpenFlight] = useState<string | null>(null);
  const tileMenu = useTileMenu();
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
  const photoLayerId = photo?.layerId;
  const spotOpen = useMemo(
    () =>
      photoLayerId && photoId
        ? { item: { kind: 'photo' as const, layer: photoLayerId, photo: photoId } }
        : null,
    [photoLayerId, photoId],
  );
  // the picks follow a photo selected elsewhere (3D, the map, an issue): a photo that is not among
  // them becomes the one pick, so a Ctrl click here starts from the open photo
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    const s = mediaPicks.getState();
    if (!photoId || !photoLayerId) {
      if (s.picks.length <= 1) s.clear();
      return;
    }
    const open = { layerId: photoLayerId, photoId };
    if (!isPicked(s, projectId, open)) s.reset(projectId, [open]);
  }, [projectId, photoId, photoLayerId]);
  const photoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!photoId) return;
    photoRef.current
      ?.querySelector(`[data-photo="${CSS.escape(photoId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [photoId]);
  // The agent set a photo filter: the first photo it shows comes into view (the photos are below
  // the videos), once per request. The effect runs after the filtered sets are drawn, also when
  // the request was made before this screen showed. No photo matches: there is nothing to find.
  const revealAsked = useMediaRevealAsked();
  useEffect(() => {
    if (!takeMediaReveal()) return;
    photoRef.current?.querySelector('.m-card.sq[data-photo]')?.scrollIntoView({ block: 'nearest' });
  }, [revealAsked]);
  if (!project)
    return (
      <>
        <PageHeader heading="nav.media" />
        <NoProject view="Media" />
      </>
    );

  const clips = layers.filter((l): l is Extract<Layer, { kind: 'video' }> => l.kind === 'video');
  const panoSets = layers.filter(
    (l): l is Extract<Layer, { kind: 'panoramas' }> => l.kind === 'panoramas',
  );
  // every level of every severity model, and always the one that is on: a level the agent set
  // shows in the select and can be cleared there, whichever model it is from
  const severityChoices = severityOptions(project.manifest.severityModels, severity);
  const empty = clips.length + photoSets.length + panoSets.length === 0;
  const withFindings = photoSets.reduce(
    (n, set) => n + set.items.filter((p) => findings.has(photoKey(set.id, p.id))).length,
    0,
  );

  const viewerOpen = photo !== null || issueId !== null;
  const hasPicks = picks.projectId === project.id && picks.picks.length > 0;

  const page = (
    <section className={`screen media${viewerOpen ? ' with-viewer' : ''}`} aria-label="Media">
      {/* the library stays in place when a photo opens beside it: its scroll and state are kept */}
      <div className="split media-split" ref={splitRef}>
        <div className="media-main" ref={photoRef} data-thumb-root>
          <header className="page-h">
            <h1>Media</h1>
            <p className="muted">
              {mediaSummary({
                clips: clips.length,
                photos: photoSets.reduce((n, l) => n + l.items.length, 0),
                panoramas: panoSets.reduce((n, l) => n + l.items.length, 0),
              })}
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
                    setMediaView({ onlyFindings: !onlyFindings });
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
                      setMediaView({ order: e.target.value as PhotoOrder });
                    }}
                  >
                    <option value="file">{t('media.findings.sort.file')}</option>
                    <option value="severity">{t('media.findings.sort.severity')}</option>
                    <option value="count">{t('media.findings.sort.count')}</option>
                  </select>
                </label>
                {severityChoices && (
                  <label className="m-order">
                    <span>{t('media.findings.severity')}</span>
                    <select
                      className="input sm"
                      value={severity === null ? '' : String(severity)}
                      data-testid="media-severity"
                      onChange={(e) => {
                        const v = e.target.value;
                        setMediaView({
                          severity: v === '' ? null : v === 'uncertain' ? 'uncertain' : Number(v),
                        });
                      }}
                    >
                      <option value="">{t('media.findings.severity.any')}</option>
                      {severityChoices.map((o) =>
                        o === 'uncertain' ? (
                          <option key={o} value={o}>
                            {t('media.findings.severity.uncertain')}
                          </option>
                        ) : (
                          <option key={o.value} value={String(o.value)}>
                            {o.label || String(o.value)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                )}
                {scope && (
                  <span className="scope-chip" data-testid="media-scope-chip">
                    {scope.label}
                    <button
                      type="button"
                      aria-label={t('view.scope.clear', { label: scope.label })}
                      onClick={() => {
                        setMediaView({ scope: null });
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                )}
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
                        document.getElementById('m-flight-clips')?.scrollIntoView({
                          block: 'nearest',
                          behavior:
                            document.documentElement.dataset.motion === 'reduce'
                              ? 'auto'
                              : 'smooth',
                        });
                      });
                    }}
                  />
                ))}
              </div>
            </section>
          )}
          {shownFlight && showsClipList(shownFlight) && (
            <section
              className="m-sec"
              id="m-flight-clips"
              aria-label={`Clips of ${shownFlight.name}`}
            >
              <h2 className="caps">
                {shownFlight.name}{' '}
                <span className="mono faint">
                  {t('media.count.clips', {
                    count: shownFlight.clips.length,
                    n: formatCount(shownFlight.clips.length),
                  })}
                </span>
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
          {noMatch && (
            <div className="side-empty" data-testid="media-no-match">
              <Icon name="filter" size={20} />
              <p>No photos match this filter.</p>
            </div>
          )}
          {shownSets.map(({ set, items }) => {
            const filtered = onlyFindings || severity !== null || scope !== null;
            if (filtered && items.length === 0) return null;
            return (
              <section className="m-sec" key={set.id}>
                <h2 className="caps">
                  {set.name}{' '}
                  <span className="mono faint">
                    {filtered
                      ? `${formatCount(items.length)} / ${formatCount(set.items.length)}`
                      : formatCount(set.items.length)}
                  </span>
                </h2>
                <div className="m-grid">
                  {items.slice(0, PHOTO_LIMIT).map((p) => {
                    const f = findings.get(photoKey(set.id, p.id));
                    const hit = { layerId: set.id, photoId: p.id };
                    const picked = isPicked(picks, project.id, hit);
                    // the picked tiles show as selected; with no picks, the open photo does
                    const on = hasPicks
                      ? picked
                      : photo?.photoId === p.id && photo.layerId === set.id;
                    const when = p.takenAt ? ` · ${formatDate(p.takenAt)}` : '';
                    const what = f
                      ? ` · ${f.label ? t('media.findings.tile', { count: f.count, severity: f.label }) : t('media.findings.tileUngraded', { count: f.count })}`
                      : '';
                    return (
                      <PhotoTile
                        key={p.id}
                        projectId={project.id}
                        layerId={set.id}
                        photo={p}
                        edited={isPhotoEdited(orientation, set.id, p)}
                        onMenu={tileMenu.open}
                      >
                        <button
                          type="button"
                          data-photo={p.id}
                          data-findings={f ? f.count : undefined}
                          data-picked={picked ? 'true' : undefined}
                          className={`m-card sq${on ? ' on' : ''}${f ? ' has-f' : ''}`}
                          style={f ? { ['--c' as string]: f.color } : undefined}
                          onClick={(e) => {
                            const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
                            mediaPicks.getState().click(project.id, hit, mods, tileOrder);
                            // Ctrl or Shift only picks; a plain click also opens the photo
                            if (mods.ctrl || mods.shift) return;
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
                                <FindingsOverlay
                                  projectId={project.id}
                                  asset={p.src}
                                  findings={f}
                                />
                              ) : undefined
                            }
                          />
                          {f && <FindingsBadge findings={f} />}
                        </button>
                      </PhotoTile>
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
                    data-pano={p.id}
                    onClick={() => {
                      // an unplaced 360 has nowhere to show in the scene: place it first
                      if (p.pos === undefined) {
                        tileMenu.place({ kind: 'pano', layerId: set.id, itemId: p.id });
                        return;
                      }
                      workspace.getState().select({ kind: 'pano', id: p.id, layer: set.id });
                      shell.getState().go('scene');
                    }}
                    onContextMenu={(e) => {
                      tileMenu.open(e, { kind: 'pano', layerId: set.id, itemId: p.id });
                    }}
                  >
                    <MediaThumb projectId={project.id} asset={panoCard(p).asset} icon="pano" />
                    <div className="m-meta">
                      <b>{p.id}</b>
                      {panoCard(p).stitched ? (
                        <span className="mono">HDG {String(p.headingDeg)}°</span>
                      ) : (
                        <span className="faint" data-testid="media-pano-unstitched">
                          {t('pano.notStitched')}
                        </span>
                      )}
                      <PanoPinChips pano={p} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {tileMenu.menu}
        </div>
        {viewerOpen && (
          <div {...splitHandle} aria-label={t('split.media')} aria-controls={viewerId}>
            <span className="kbd split-readout" aria-hidden="true" />
          </div>
        )}
        {issueId && !photo && (
          <aside id={viewerId} className="media-viewer media-card" aria-label={t('card.title')}>
            <IssueCard issueId={issueId} place="media" className="fill-col" />
          </aside>
        )}
        {photo && (
          <FocusZone id={viewerId} kind="photo" className="media-viewer" aria-label="Photo">
            <div className="panel-h">
              <h2>
                <Icon name="photo" size={14} />
                {photo.photoId}
              </h2>
              <div className="acts">
                {spotOpen && <SpotHistoryButton open={spotOpen} />}
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
            {spotOpen && <InlineSpotStrip open={spotOpen} />}
          </FocusZone>
        )}
      </div>
    </section>
  );
  return (
    <>
      <PageHeader heading="nav.media" />
      {page}
    </>
  );
}
