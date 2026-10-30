import { PhotoViewer, VideoAnnotator } from '@aio/annotate';
import { shiftedLayer, type Layer, type ReportFile } from '@aio/schema';
import {
  Chip,
  Icon,
  IconButton,
  SplitHandle,
  Tip,
  useResizableSplit,
  useT,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { VideoWindow } from '@aio/video';
import {
  assetUrl,
  counterpart,
  dateShiftOf,
  dateTags,
  useWorkspace,
  workspace,
  type CaptureIndex,
} from '@aio/workspace';
import { useEffect, useLayoutEffect, useMemo, type ReactNode, type RefObject } from 'react';
import { FocusZone } from '../FocusZone';
import {
  closeEvidence,
  dropEvidence,
  stepEvidence,
  useEvidence,
  type EvidenceOpen,
} from '../issueCard/evidence';
import { issueEvidence, photoEvidence } from '../issueCard/model';
import { openLightbox } from '../issueCard/state';
import { PdfViewer } from '../report/PdfViewer';
import { useCall } from '../shell';
import { DrawingPane, RasterOptions } from '../drawings/DrawingPane';
import { useWalks } from '../walks/walks';
import { captureLabel, useCaptureIndex, useSplitDates } from './compare';
import { DateBadge, pickPhotoSet } from './DatesOnScreen';
import { SameViewButton } from './FramesPane';
import { panosOf } from './panoPair';
import { PanoPane } from './PanoPane';
import {
  chooseAt,
  chooseCapture,
  paneGroups,
  paneOptions,
  paneValue,
  parsePaneValue,
  PER_CAPTURE,
  resolveSplit,
  sideCapture,
  twinAllowed,
  type PaneKind,
  type Side,
  type SplitDates,
  type SplitPref,
} from './splitModel';
import { SpotHistoryButton } from './spot/SpotHistoryEntry';
import { stagePrefs, useStagePrefs } from './stagePrefs';
import { useTimeline } from './timeline';

/** The panes this file draws itself. */
type BuiltInPane = '3d' | 'map' | 'video' | 'photo' | 'raster' | 'pano' | 'report';

/**
 * Mount point for panes of later streams (M8). To add one, a stream adds its kind to `PaneKind`,
 * `PANE_KINDS` and `paneOptions` in splitModel.ts, and one entry here, e.g. C4:
 * `frames: { label: 'stage.pane.frames', icon: 'video', zone: 'video', render: (p) => <FramesPane {...p} /> },`
 * Nothing else in this file changes: the chooser (one select grouped by survey date, see
 * `paneGroups`), the focus zone and the pane body read it.
 */
export const EXTRA_PANES: Partial<
  Record<
    PaneKind,
    {
      label: MessageKey;
      icon: IconName;
      zone: 'video' | 'photo' | 'map' | 'report';
      render: (p: { split: SplitModel; side: Side }) => ReactNode;
    }
  >
> = {};

const BUILT_IN: Record<BuiltInPane, { label: MessageKey; icon: IconName }> = {
  '3d': { label: 'stage.pane.3d', icon: 'scene' },
  map: { label: 'stage.pane.map', icon: 'map' },
  video: { label: 'stage.pane.video', icon: 'video' },
  photo: { label: 'stage.pane.photo', icon: 'photo' },
  raster: { label: 'stage.pane.raster', icon: 'raster' },
  pano: { label: 'stage.pane.pano', icon: 'pano' },
  report: { label: 'stage.pane.report', icon: 'report' },
};

function paneInfo(kind: PaneKind): { label: MessageKey; icon: IconName } {
  return (
    (BUILT_IN as Partial<Record<PaneKind, { label: MessageKey; icon: IconName }>>)[kind] ??
    EXTRA_PANES[kind] ?? { label: 'stage.pane.3d', icon: 'scene' }
  );
}

export interface SplitModel {
  options: PaneKind[];
  sides: SplitPref;
  reports: ReportFile[];
  set(next: SplitPref): void;
  /** The project's captures and their layers (null without a project). */
  index: CaptureIndex | null;
  /** Survey dates the split can compare (absent: fewer than two dated captures). */
  dates?: SplitDates | undefined;
  /** How many walks the project has (360 video shows on both sides only with two or more). */
  walks?: number;
}

/** The open project's split: which panes it offers and what each side shows (remembered). */
export function useSplit(): SplitModel {
  const project = useWorkspace((s) => s.project);
  const id = project?.id ?? null;
  const listed = useCall('report:list', { projectId: id ?? '' }, id);
  const reports = useMemo(() => (listed?.ok ? listed.value.files : []), [listed]);
  const saved = useStagePrefs((s) => (id ? s.byProject[id]?.split : undefined));
  const index = useCaptureIndex();
  const dates = useSplitDates(index);
  // 360 video is kept beside the manifest (walks/), so its count comes from its own store
  const walkCount = useWalks((s) => s.walks.length);
  const options = useMemo(
    () =>
      paneOptions(project?.manifest.layers ?? [], reports.length, dates?.captures.length, {
        walks: walkCount,
      }),
    [project, reports, dates, walkCount],
  );
  const sides = useMemo(
    () => resolveSplit(saved, options, dates, walkCount),
    [saved, options, dates, walkCount],
  );
  return {
    options,
    sides,
    reports,
    index,
    dates,
    walks: walkCount,
    set: (next) => {
      if (id) stagePrefs.getState().update(id, { split: next });
    },
  };
}

/** Both sides show one kind of pane, one survey date each. */
export function isTwin(split: SplitModel): boolean {
  return split.sides.left === split.sides.right && twinAllowed(split.sides.left, split.dates);
}

/** The survey date a side shows, when its pane is drawn per date and the project has two. */
export function paneCapture(split: SplitModel, side: Side): string | undefined {
  const kind = split.sides[side];
  if (!split.dates || !PER_CAPTURE.includes(kind)) return undefined;
  return sideCapture(split.sides, side, split.dates);
}

/**
 * A split pane's header strip (D31): the survey date the side shows, the view it shows (one list
 * grouped by survey date, newest first, then the panes of any date, when the project has two
 * dates) and, on the right of two linked views, the link toggle. It sits under the island, and no
 * corner overlay covers it.
 */
export function PaneHeader({
  side,
  split,
  end,
}: {
  side: Side;
  split: SplitModel;
  /** More of the pane's own controls, at the strip's end (the evidence's close button). */
  end?: ReactNode;
}) {
  const t = useT();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const current = split.sides[side];
  const capture = paneCapture(split, side);
  const index = split.index;
  const twin = isTwin(split);
  const linked = !split.sides.unlinked;
  const has = (kind: PaneKind, c: string): boolean => {
    // the side's own pane stays listed, even on a date without its data
    if (kind === current && c === capture) return true;
    if (kind === 'raster')
      return (layers ?? []).some(
        (l) => l.kind === 'raster' && (index?.of[l.id] === undefined || index.of[l.id] === c),
      );
    if (kind === 'pano') return panosOf(layers ?? [], index, c).length > 0;
    return true;
  };
  const groups = paneGroups(split.sides, side, split.options, split.dates, has, split.walks);
  const options = (g: (typeof groups)[number]) =>
    g.options.map((o) => (
      <option key={o.value} value={o.value} disabled={o.disabled}>
        {t(paneInfo(o.kind).label)}
      </option>
    ));
  return (
    // over the stage (street map, imagery), like the island: dark in every theme
    <div
      className={`pane-head side-${side}`}
      data-testid={`pane-chooser-${side}`}
      data-surface="dark"
    >
      <div className="pane-head-main overlay-box">
        <Icon name={paneInfo(current).icon} size={14} className="muted" />
        {capture !== undefined && index && (
          <span className="pane-date" data-testid="pane-date">
            <Chip kind="tag">
              <span
                className="dtag"
                style={{ background: dateTags(index.captures)[capture]?.colour }}
                aria-hidden="true"
              />
              <span className="pane-date-t">{captureLabel(index, capture)}</span>
            </Chip>
          </span>
        )}
        {/* a narrow pane cuts the view's name: the tip gives it whole */}
        <Tip content={t(paneInfo(current).label)}>
          <select
            className="input"
            data-testid={`pane-select-${side}`}
            aria-label={t(side === 'left' ? 'stage.split.left' : 'stage.split.right')}
            value={paneValue(current, capture ?? null)}
            onChange={(e) => {
              const picked = parsePaneValue(e.target.value);
              if (!picked) return;
              dropEvidence();
              split.set(
                chooseAt(split.sides, side, picked.kind, picked.capture, split.dates, split.walks),
              );
            }}
          >
            {groups.length < 2
              ? groups.map(options)
              : groups.map((g) => (
                  <optgroup
                    key={g.capture ?? ''}
                    label={
                      g.capture && index ? captureLabel(index, g.capture) : t('stage.pane.anyDate')
                    }
                  >
                    {options(g)}
                  </optgroup>
                ))}
          </select>
        </Tip>
      </div>
      {twin && side === 'right' && (
        <IconButton
          icon="link"
          className="pane-link overlay-box"
          data-testid="compare-link"
          pressed={linked}
          label={t(linked ? 'stage.compare.unlink' : 'stage.compare.link')}
          onClick={() => {
            split.set({ ...split.sides, ...(linked ? { unlinked: true } : { unlinked: false }) });
          }}
        />
      )}
      {end}
    </div>
  );
}

/** The Split view's divider: its share of the stage is kept on this computer under this id. */
export const SPLIT_ID = 'scene.split';

/**
 * The divider between the two sides of the Split view (D31): the shared `ResizableSplit`, sized
 * from the left side as a share of the stage. Drag it, or use the arrow keys on it; double-click
 * puts it back in the middle. Each side keeps 200 px, or half a stage too narrow for that.
 * `containerRef` goes on the panes' grid, which lays the panes out itself (they keep their
 * canvas as the sides change), and `handle` inside it; off (no split), there is no handle.
 */
export function useSplitDivider(on: boolean): {
  containerRef: RefObject<HTMLDivElement | null>;
  handle: ReactNode;
} {
  const t = useT();
  const { containerRef, separatorProps } = useResizableSplit({
    id: SPLIT_ID,
    orientation: 'horizontal',
    sized: 'start',
    unit: 'fraction',
    defaultSize: 0.5,
    min: 200,
    minShare: 0.5,
    max: '100%',
    otherMin: 200,
  });
  const paneId = separatorProps['aria-controls'];
  // the handle names the pane it sizes: the left one, whichever pane that is now
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !paneId) return;
    const left = on ? el.querySelector(':scope > [data-side="left"]') : null;
    for (const pane of el.querySelectorAll(`:scope > [id="${paneId}"]`))
      if (pane !== left) pane.removeAttribute('id');
    if (left) left.id = paneId;
  });
  // each side's width, at the reading start and end, for the corner overlays over it
  // (--pane-start-w, --pane-end-w on the views; styles.css .stage-slot): a chip keeps to its pane
  useEffect(() => {
    const el = containerRef.current;
    const host = el?.parentElement;
    if (!el || !host || !on || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      const width = (side: Side) =>
        el.querySelector(`:scope > [data-side="${side}"]`)?.getBoundingClientRect().width ?? 0;
      const [left, right] = [width('left'), width('right')];
      if (!left || !right) return;
      const rtl = document.documentElement.dir === 'rtl';
      host.style.setProperty('--pane-start-w', `${String(rtl ? right : left)}px`);
      host.style.setProperty('--pane-end-w', `${String(rtl ? left : right)}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    for (const pane of el.querySelectorAll(':scope > [data-side]')) ro.observe(pane);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--pane-start-w');
      host.style.removeProperty('--pane-end-w');
    };
  }, [on, containerRef]);
  return {
    containerRef,
    handle: on ? <SplitHandle separatorProps={separatorProps} label={t('split.scene')} /> : null,
  };
}

/**
 * The leading Panoramas pane picked `key` (stepped, followed or selected elsewhere): remember it.
 * From the left, when its layer belongs to another survey date, move the left side to that date;
 * a leading right pane only picks panoramas of its own date, so its pick moves no date.
 */
export function pickPano(split: SplitModel, key: string, side: Side = 'left'): void {
  const next: SplitPref = { ...split.sides, pano: key };
  if (side === 'right') {
    split.set(next);
    return;
  }
  const slash = key.lastIndexOf('/');
  const layer = slash < 0 ? key : key.slice(0, slash);
  const at = split.index?.of[layer];
  split.set(
    at !== undefined && split.dates && at !== paneCapture(split, 'left')
      ? chooseCapture(next, 'left', at, split.dates)
      : next,
  );
}

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

function VideoPane() {
  const t = useT();
  const clip = useWorkspace((s) => s.activeClip);
  const dated = useTimeline((s) => (clip ? s.index?.of[clip] !== undefined : false));
  if (!clip) return <p className="pane-empty">{t('stage.pane.noClip')}</p>;
  return (
    <div className="pane-col">
      {dated && (
        <div className="pane-bar">
          <DateBadge layerId={clip} />
        </div>
      )}
      <VideoWindow layerId={clip} className="fill-col">
        <VideoAnnotator key={clip} layerId={clip} />
      </VideoWindow>
    </div>
  );
}

/**
 * The photos of an issue picked in 3D, its boxes and masks drawn: previous and next step through
 * the issue's photos, the x (or Esc) puts the stage back as it was.
 */
function EvidencePhotos({ open }: { open: EvidenceOpen }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const issue = useWorkspace((s) => s.issues.find((i) => i.id === open.issueId));
  const photos = useMemo(
    () => (project && issue ? photoEvidence(issueEvidence(project.manifest, issue)) : []),
    [project, issue],
  );
  const index = Math.min(open.index, photos.length - 1);
  const ev = photos[index];
  if (!issue || !ev) return <p className="pane-empty">{t('stage.pane.noPhoto')}</p>;
  return (
    <div className="pane-col" data-testid="evidence-photo" data-issue={issue.id}>
      <div className="pane-bar">
        <b className="mono">{issue.code}</b>
        <IconButton
          icon="back"
          label={t('lightbox.prev')}
          disabled={photos.length < 2}
          onClick={() => {
            stepEvidence(-1, photos.length);
          }}
        />
        <span className="mono" data-testid="evidence-photo-id">
          {ev.photo}
        </span>
        <span className="mono faint">
          {t('stage.pane.photoCount', { n: index + 1, total: photos.length })}
        </span>
        <IconButton
          icon="fwd"
          label={t('lightbox.next')}
          disabled={photos.length < 2}
          onClick={() => {
            stepEvidence(1, photos.length);
          }}
        />
        <span className="grow" />
        <IconButton
          icon="maximize"
          label={t('evidence.full')}
          onClick={() => {
            openLightbox(issue.id, index);
          }}
        />
        <IconButton
          icon="x"
          label={t('evidence.close')}
          tip={`${t('evidence.close')} (Esc)`}
          data-testid="evidence-close"
          onClick={() => {
            closeEvidence();
          }}
        />
      </div>
      <PhotoViewer
        key={ev.key}
        layerId={ev.layer}
        photoId={ev.photo}
        projected={false}
        className="fill-col"
      />
    </div>
  );
}

/** The issue's photos while its evidence is open, else the selected photo. */
function PhotoPane() {
  const open = useEvidence((s) => (s.open?.kind === 'photo' ? s.open : null));
  return open ? <EvidencePhotos open={open} /> : <SetPhotoPane />;
}

/** The selected photo (picked in 3D, Media or an issue), else the first; steps through its set. */
function SetPhotoPane() {
  const t = useT();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const selection = useWorkspace((s) => s.selection);
  const sets = (layers ?? []).filter((l): l is PhotoLayer => l.kind === 'photos');
  const picked =
    selection?.kind === 'photo'
      ? sets.find((s) => s.id === selection.layer && s.items.some((p) => p.id === selection.id))
      : undefined;
  const hidden = useWorkspace((s) => s.hidden);
  const timelineIndex = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const set = picked ?? pickPhotoSet(sets, hidden, timelineIndex, focus);
  if (!set) return <p className="pane-empty">{t('stage.pane.noPhoto')}</p>;
  const index = Math.max(
    0,
    set.items.findIndex((p) => selection?.kind === 'photo' && p.id === selection.id),
  );
  const photo = set.items[index];
  if (!photo) return <p className="pane-empty">{t('stage.pane.noPhoto')}</p>;
  const go = (d: number) => {
    const next = set.items[(index + d + set.items.length) % set.items.length];
    if (next) workspace.getState().select({ kind: 'photo', id: next.id, layer: set.id });
  };
  return (
    <div className="pane-col">
      <div className="pane-bar">
        <DateBadge layerId={set.id} />
        <IconButton
          icon="back"
          label={t('stage.pane.prevPhoto')}
          onClick={() => {
            go(-1);
          }}
        />
        <span className="mono">{photo.id}</span>
        <span className="mono faint">
          {t('stage.pane.photoCount', { n: index + 1, total: set.items.length })}
        </span>
        <IconButton
          icon="fwd"
          label={t('stage.pane.nextPhoto')}
          onClick={() => {
            go(1);
          }}
        />
        <SameViewButton source={{ kind: 'photo', layer: set.id, photo: photo.id }} />
        <SpotHistoryButton open={{ item: { kind: 'photo', layer: set.id, photo: photo.id } }} />
      </div>
      <PhotoViewer layerId={set.id} photoId={photo.id} className="fill-col" />
    </div>
  );
}

function RasterPane({ split, side }: { split: SplitModel; side: Side }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const capture = paneCapture(split, side);
  const index = split.index;
  // with two dates, the side lists its date's rasters and the undated ones
  const rasters = (project?.manifest.layers ?? []).filter(
    (l): l is RasterLayer =>
      l.kind === 'raster' &&
      (!capture || index?.of[l.id] === undefined || index.of[l.id] === capture),
  );
  const chosen = split.sides.raster;
  const mapped = chosen && capture && index ? counterpart(index, chosen, capture) : chosen;
  const layer = rasters.find((l) => l.id === mapped) ?? rasters[0];
  const twin = isTwin(split);
  // the picture lies where its date's line-up puts it, so that two dates swipe and link in place
  const shift = project && layer ? dateShiftOf(project.manifest, layer.id) : null;
  const placed = useMemo(
    () => (layer && shift ? (shiftedLayer(layer, shift) as RasterLayer) : layer),
    [layer, shift],
  );
  if (!project || !layer || !placed) return null;
  return (
    <div className="pane-col">
      {rasters.length > 1 && (
        <div className="pane-bar">
          <select
            className="input"
            aria-label={t('stage.pane.whichRaster')}
            value={layer.id}
            onChange={(e) => {
              split.set({ ...split.sides, raster: e.target.value });
            }}
          >
            <RasterOptions rasters={rasters} />
          </select>
        </div>
      )}
      <DrawingPane
        key={layer.id}
        projectId={project.id}
        layer={placed}
        link={twin && !split.sides.unlinked ? side : null}
      />
    </div>
  );
}

function ReportPane({ split }: { split: SplitModel }) {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id);
  const file = split.reports.find((f) => f.path === split.sides.report) ?? split.reports[0];
  if (!projectId || !file) return null;
  return (
    <div className="pane-col">
      {split.reports.length > 1 && (
        <div className="pane-bar">
          <select
            className="input"
            aria-label={t('stage.pane.whichReport')}
            value={file.path}
            onChange={(e) => {
              split.set({ ...split.sides, report: e.target.value });
            }}
          >
            {split.reports.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="fill-col pane-report">
        <PdfViewer
          key={file.path}
          url={assetUrl(projectId, { path: file.path })}
          title={file.name}
        />
      </div>
    </div>
  );
}

const ZONE: Record<Exclude<BuiltInPane, '3d' | 'map'>, 'video' | 'photo' | 'map' | 'report'> = {
  video: 'video',
  photo: 'photo',
  raster: 'map',
  pano: 'photo',
  report: 'report',
};

/** A split side that shows something other than the 3D view or the map. */
export function SplitPane({ side, split }: { side: Side; split: SplitModel }) {
  const t = useT();
  const kind = split.sides[side];
  const videoEvidence = useEvidence((s) => s.open?.kind === 'video');
  if (kind === '3d' || kind === 'map') return null;
  const extra = EXTRA_PANES[kind];
  return (
    <FocusZone
      kind={
        extra
          ? extra.zone
          : ((ZONE as Partial<Record<PaneKind, 'video' | 'photo' | 'map' | 'report'>>)[kind] ??
            'map')
      }
      className={`pane pane-x pane-${kind}`}
      data-side={side}
      // the Panoramas pane names itself `pane-pano` (with its date and panorama)
      data-testid={kind === 'pano' ? undefined : `pane-${kind}`}
    >
      {extra ? (
        extra.render({ split, side })
      ) : kind === 'video' ? (
        <VideoPane />
      ) : kind === 'photo' ? (
        <PhotoPane />
      ) : kind === 'raster' ? (
        <RasterPane split={split} side={side} />
      ) : kind === 'pano' ? (
        <PanoPane
          side={side}
          capture={paneCapture(split, side)}
          otherCapture={paneCapture(split, side === 'left' ? 'right' : 'left')}
          sides={split.sides}
          linked={!split.sides.unlinked}
          onPick={(key) => {
            // only the leading pane picks (a following right pane shows the nearest of its date)
            pickPano(split, key, side);
          }}
        />
      ) : (
        <ReportPane split={split} />
      )}
      <PaneHeader
        side={side}
        split={split}
        end={
          kind === 'video' && videoEvidence ? (
            <IconButton
              icon="x"
              label={t('evidence.close')}
              tip={`${t('evidence.close')} (Esc)`}
              className="overlay-box pane-close"
              data-testid="evidence-close"
              onClick={() => {
                closeEvidence();
              }}
            />
          ) : undefined
        }
      />
    </FocusZone>
  );
}
