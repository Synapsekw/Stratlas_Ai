import type { Layer, ProjectManifest } from '@aio/schema';
import {
  formatClock,
  formatCount,
  formatDate,
  formatDuration,
  Icon,
  shortcutHint,
  useT,
  type PhotoPick,
} from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useMedia } from '../media';
import { photoKey, type PhotoFindings, type PhotoOrder } from '../screens/mediaFindings';
import {
  flightCards,
  flightOf,
  isPhotoEdited,
  panoCard,
  showsClipList,
} from '../screens/mediaModel';
import { PanoPinChips, PhotoTile, useTileMenu } from '../screens/MediaPins';
import { isPicked, mediaPicks, useMediaPicks } from '../screens/mediaSelect';
import {
  noPhotoMatches,
  photosInView,
  setMediaView,
  severityOptions,
  takeMediaReveal,
  useMediaRevealAsked,
  useMediaView,
} from '../screens/mediaView';
import { shell } from '../shell';
import { MediaThumb } from '../thumbs/Thumb';
import { clipLabel, FlightTile, playClip } from './FlightTile';
import { chipCounts, type PhotoChip } from './findings';
import './photoColumn.css';

const PHOTO_LIMIT = 600;

/**
 * The photo column of Inspect: the project's photos in a single column of tiles, 2 across, with
 * the chips that narrow them to what waits for review, the two badges of a tile (AI suggestions
 * waiting, confirmed findings), and everything Media did for a tile besides findings: picks, the
 * right-click actions, 360s, flights and clips.
 */
export function PhotoColumn(p: {
  projectId: string;
  manifest: ProjectManifest;
  index: ReadonlyMap<string, PhotoFindings>;
  open: PhotoPick | null;
  /** Called with the tile order as shown; the screen uses it for J/K, position and Shift ranges. */
  onOrder: (order: readonly PhotoPick[]) => void;
}): ReactElement {
  const { projectId, manifest, index, open, onOrder } = p;
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const activeClip = useWorkspace((s) => s.activeClip);
  const orientation = useWorkspace((s) => s.orientation);
  const view = useMediaView((s) => s);
  const { onlyFindings, toReview, order, severity, scope } = view;
  const { durations } = useMedia(project);
  const picks = useMediaPicks((s) => s);
  const tileMenu = useTileMenu();
  const [openFlight, setOpenFlight] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const layers = manifest.layers;
  const flights = useMemo(() => flightCards(layers, durations), [layers, durations]);
  const shownFlight = flights.find((f) => f.id === openFlight) ?? flightOf(flights, activeClip);
  const photoSets = useMemo(
    () => layers.filter((l): l is Extract<Layer, { kind: 'photos' }> => l.kind === 'photos'),
    [layers],
  );
  const panoSets = layers.filter(
    (l): l is Extract<Layer, { kind: 'panoramas' }> => l.kind === 'panoramas',
  );
  const counts = useMemo(() => chipCounts(photoSets, index), [photoSets, index]);
  const shownSets = useMemo(
    () => photoSets.map((set) => ({ set, items: photosInView(set.items, set.id, index, view) })),
    [photoSets, index, view],
  );
  // "To review" with nothing waiting shows no tile: it says so rather than leave a blank column
  const noMatch = useMemo(
    () =>
      noPhotoMatches(photoSets, index, view) ||
      (toReview && photoSets.length > 0 && shownSets.every((s) => s.items.length === 0)),
    [photoSets, index, view, toReview, shownSets],
  );
  // the photo tiles as shown, in order: J/K, the position and a Shift range read it
  const tileOrder = useMemo(
    () =>
      shownSets.flatMap(({ set, items }) =>
        items.slice(0, PHOTO_LIMIT).map((it) => ({ layerId: set.id, photoId: it.id })),
      ),
    [shownSets],
  );
  useEffect(() => {
    onOrder(tileOrder);
  }, [tileOrder, onOrder]);

  // the picks follow the open photo (picked here, in 3D or from an issue): a photo that is not
  // among them becomes the one pick, so a Ctrl click here starts from the open photo
  const openLayer = open?.layerId;
  const openPhotoId = open?.photoId;
  useEffect(() => {
    const s = mediaPicks.getState();
    if (!openPhotoId || !openLayer) {
      if (s.picks.length <= 1) s.clear();
      return;
    }
    const hit = { layerId: openLayer, photoId: openPhotoId };
    if (!isPicked(s, projectId, hit)) s.reset(projectId, [hit]);
  }, [projectId, openPhotoId, openLayer]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openPhotoId) return;
    listRef.current
      ?.querySelector(`[data-photo="${CSS.escape(openPhotoId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [openPhotoId]);
  // the agent set a photo filter: the first photo it shows comes into view, once per request
  const revealAsked = useMediaRevealAsked();
  useEffect(() => {
    if (!takeMediaReveal()) return;
    listRef.current?.querySelector('.m-card.sq[data-photo]')?.scrollIntoView({ block: 'nearest' });
  }, [revealAsked]);

  const severityChoices = severityOptions(manifest.severityModels, severity);
  const hasPicks = picks.projectId === projectId && picks.picks.length > 0;
  const filtered = toReview || onlyFindings || severity !== null || scope !== null;
  const active: PhotoChip = toReview ? 'review' : onlyFindings ? 'findings' : 'all';
  const chip = (
    id: PhotoChip,
    label: string,
    patch: { toReview: boolean; onlyFindings: boolean },
  ) => (
    <button
      type="button"
      className={`insp-chip${active === id ? ' on' : ''}`}
      aria-pressed={active === id}
      data-testid={`inspect-chip-${id}`}
      onClick={() => {
        setMediaView(patch);
      }}
    >
      {label}
      <span className="mono" data-testid={`inspect-chip-${id}-count`}>
        {formatCount(counts[id])}
      </span>
    </button>
  );

  return (
    <div className="insp-photos-col">
      <header className="insp-photos-h">
        <h2>
          {t('inspect.photos')} <span className="mono faint">{formatCount(counts.all)}</span>
        </h2>
        <div className="insp-chips" role="group" aria-label={t('inspect.photos')}>
          {chip('review', t('inspect.chip.review'), { toReview: true, onlyFindings: false })}
          {chip('findings', t('inspect.chip.findings'), { toReview: false, onlyFindings: true })}
          {chip('all', t('inspect.chip.all'), { toReview: false, onlyFindings: false })}
          <button
            type="button"
            className={`btn icon sm ghost${filterOpen ? ' on' : ''}`}
            aria-expanded={filterOpen}
            aria-label={t('inspect.filter')}
            title={t('inspect.filter')}
            data-testid="inspect-filter"
            onClick={() => {
              setFilterOpen((v) => !v);
            }}
          >
            <Icon name="filter" size={14} />
          </button>
        </div>
        {filterOpen && (
          <div className="insp-filter" role="group" aria-label={t('inspect.filter')}>
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
          </div>
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
      </header>
      <div className="insp-photos-list" ref={listRef} data-thumb-root>
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
                  projectId={projectId}
                  open={f.id === shownFlight?.id}
                  playing={f.clips.some((c) => c.id === activeClip)}
                  onOpen={() => {
                    setOpenFlight(f.id);
                    requestAnimationFrame(() => {
                      document.getElementById('m-flight-clips')?.scrollIntoView({
                        block: 'nearest',
                        behavior:
                          document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth',
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
                    <MediaThumb projectId={projectId} asset={c.poster} icon="video" thumb={false} />
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
                {items.slice(0, PHOTO_LIMIT).map((ph) => {
                  const f = index.get(photoKey(set.id, ph.id));
                  const waiting = f?.drafts ?? 0;
                  const confirmed = f?.issues ?? 0;
                  const hit = { layerId: set.id, photoId: ph.id };
                  const picked = isPicked(picks, projectId, hit);
                  // the picked tiles show as selected; with no picks, the open photo does
                  const on = hasPicks ? picked : open?.photoId === ph.id && open.layerId === set.id;
                  const when = ph.takenAt ? ` · ${formatDate(ph.takenAt)}` : '';
                  const aiText = waiting > 0 ? t('inspect.badge.ai', { count: waiting }) : '';
                  const okText =
                    confirmed > 0 ? t('inspect.badge.confirmed', { count: confirmed }) : '';
                  const what = [aiText, okText].filter(Boolean).join(', ');
                  return (
                    <PhotoTile
                      key={ph.id}
                      projectId={projectId}
                      layerId={set.id}
                      photo={ph}
                      edited={isPhotoEdited(orientation, set.id, ph)}
                      onMenu={tileMenu.open}
                    >
                      <button
                        type="button"
                        data-photo={ph.id}
                        data-picked={picked ? 'true' : undefined}
                        data-ai={waiting > 0 ? waiting : undefined}
                        data-confirmed={confirmed > 0 ? confirmed : undefined}
                        className={`m-card sq${on ? ' on' : ''}`}
                        onClick={(e) => {
                          const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
                          mediaPicks.getState().click(projectId, hit, mods, tileOrder);
                          // Ctrl or Shift only picks; a plain click also opens the photo
                          if (mods.ctrl || mods.shift) return;
                          workspace.getState().select({ kind: 'photo', id: ph.id, layer: set.id });
                        }}
                        title={`${ph.id}${when}${what ? ` · ${what}` : ''}`}
                        aria-label={what ? `${ph.id} · ${what}` : ph.id}
                      >
                        <MediaThumb projectId={projectId} asset={ph.src} icon="photo" />
                        {waiting > 0 && (
                          <span className="insp-b ai mono" role="img" aria-label={aiText}>
                            <i />
                            {waiting}
                          </span>
                        )}
                        {confirmed > 0 && f && (
                          <span
                            className="insp-b ok mono"
                            role="img"
                            aria-label={okText}
                            style={{ ['--c' as string]: f.color }}
                          >
                            <i />
                            {confirmed}
                          </span>
                        )}
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
            <div className="m-grid">
              {set.items.map((pano) => (
                <button
                  key={pano.id}
                  type="button"
                  className="m-card"
                  data-pano={pano.id}
                  onClick={() => {
                    // an unplaced 360 has nowhere to show in the scene: place it first
                    if (pano.pos === undefined) {
                      tileMenu.place({ kind: 'pano', layerId: set.id, itemId: pano.id });
                      return;
                    }
                    workspace.getState().select({ kind: 'pano', id: pano.id, layer: set.id });
                    shell.getState().go('scene');
                  }}
                  onContextMenu={(e) => {
                    tileMenu.open(e, { kind: 'pano', layerId: set.id, itemId: pano.id });
                  }}
                >
                  <MediaThumb projectId={projectId} asset={panoCard(pano).asset} icon="pano" />
                  <div className="m-meta">
                    <b>{pano.id}</b>
                    {panoCard(pano).stitched ? (
                      <span className="mono">HDG {String(pano.headingDeg)}°</span>
                    ) : (
                      <span className="faint" data-testid="media-pano-unstitched">
                        {t('pano.notStitched')}
                      </span>
                    )}
                    <PanoPinChips pano={pano} />
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
        {tileMenu.menu}
      </div>
      <footer className="insp-legend" data-testid="inspect-legend">
        <span>
          <i className="ai" />
          {t('inspect.legend.ai')}
        </span>
        <span>
          <i className="ok" />
          {t('inspect.legend.confirmed')}
        </span>
      </footer>
    </div>
  );
}
