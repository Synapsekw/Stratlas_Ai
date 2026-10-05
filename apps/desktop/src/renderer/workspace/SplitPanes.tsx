import { PhotoViewer, VideoAnnotator } from '@aio/annotate';
import type { Layer, ReportFile } from '@aio/schema';
import { Icon, useT, type IconName, type MessageKey } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { assetUrl, counterpart, useWorkspace, workspace, type CaptureIndex } from '@aio/workspace';
import { useMemo } from 'react';
import { FocusZone } from '../FocusZone';
import { PdfViewer } from '../report/PdfViewer';
import { useCall } from '../shell';
import { captureLabel, useCaptureIndex, useSplitDates } from './compare';
import { RasterView } from './RasterPane';
import {
  blockedFor,
  chooseCapture,
  chooseSide,
  paneOptions,
  PER_CAPTURE,
  resolveSplit,
  sideCapture,
  twinAllowed,
  type PaneKind,
  type Side,
  type SplitDates,
  type SplitPref,
} from './splitModel';
import { stagePrefs, useStagePrefs } from './stagePrefs';

const PANE: Record<PaneKind, { label: MessageKey; icon: IconName }> = {
  '3d': { label: 'stage.pane.3d', icon: 'scene' },
  map: { label: 'stage.pane.map', icon: 'map' },
  video: { label: 'stage.pane.video', icon: 'video' },
  photo: { label: 'stage.pane.photo', icon: 'photo' },
  raster: { label: 'stage.pane.raster', icon: 'raster' },
  report: { label: 'stage.pane.report', icon: 'report' },
};

export interface SplitModel {
  options: PaneKind[];
  sides: SplitPref;
  reports: ReportFile[];
  set(next: SplitPref): void;
  /** The project's captures and their layers (null without a project). */
  index: CaptureIndex | null;
  /** Survey dates the split can compare (absent: fewer than two dated captures). */
  dates?: SplitDates | undefined;
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
  const options = useMemo(
    () => paneOptions(project?.manifest.layers ?? [], reports.length),
    [project, reports],
  );
  const sides = useMemo(() => resolveSplit(saved, options, dates), [saved, options, dates]);
  return {
    options,
    sides,
    reports,
    index,
    dates,
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

/** The small selector in a pane's corner: what this side of the split shows, and its date. */
export function PaneChooser({ side, split }: { side: Side; split: SplitModel }) {
  const t = useT();
  const current = split.sides[side];
  const blocked = blockedFor(split.sides, side, split.dates);
  const capture = paneCapture(split, side);
  const index = split.index;
  const twin = isTwin(split);
  const linked = !split.sides.unlinked;
  return (
    <div className={`pane-chooser overlay-box side-${side}`} data-testid={`pane-chooser-${side}`}>
      <Icon name={PANE[current].icon} size={14} className="muted" />
      <select
        className="input"
        aria-label={t(side === 'left' ? 'stage.split.left' : 'stage.split.right')}
        value={current}
        onChange={(e) => {
          split.set(chooseSide(split.sides, side, e.target.value as PaneKind, split.dates));
        }}
      >
        {split.options.map((k) => (
          <option key={k} value={k} disabled={k === blocked}>
            {t(PANE[k].label)}
          </option>
        ))}
      </select>
      {capture !== undefined && index && split.dates && (
        <select
          className="input pane-date"
          data-testid={`pane-date-${side}`}
          aria-label={t(side === 'left' ? 'stage.compare.leftDate' : 'stage.compare.rightDate')}
          title={t('stage.compare.dateTip')}
          value={capture}
          onChange={(e) => {
            split.set(chooseCapture(split.sides, side, e.target.value, split.dates));
          }}
        >
          {index.captures.map((c) => (
            <option key={c.id} value={c.id}>
              {captureLabel(index, c.id)}
            </option>
          ))}
        </select>
      )}
      {twin && side === 'right' && (
        <button
          type="button"
          className="btn icon sm ghost pane-link"
          data-testid="compare-link"
          aria-pressed={linked}
          aria-label={t(linked ? 'stage.compare.unlink' : 'stage.compare.link')}
          title={t(linked ? 'stage.compare.unlink' : 'stage.compare.link')}
          onClick={() => {
            split.set({ ...split.sides, ...(linked ? { unlinked: true } : { unlinked: false }) });
          }}
        >
          <Icon name="link" size={14} />
        </button>
      )}
    </div>
  );
}

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

function VideoPane() {
  const t = useT();
  const clip = useWorkspace((s) => s.activeClip);
  if (!clip) return <p className="pane-empty">{t('stage.pane.noClip')}</p>;
  return (
    <VideoWindow layerId={clip} className="scene-fill">
      <VideoAnnotator key={clip} layerId={clip} />
    </VideoWindow>
  );
}

/** The selected photo (picked in 3D, Media or an issue), else the first; steps through its set. */
function PhotoPane() {
  const t = useT();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const selection = useWorkspace((s) => s.selection);
  const sets = (layers ?? []).filter((l): l is PhotoLayer => l.kind === 'photos');
  const picked =
    selection?.kind === 'photo'
      ? sets.find((s) => s.id === selection.layer && s.items.some((p) => p.id === selection.id))
      : undefined;
  const set = picked ?? sets.find((s) => s.items.length > 0);
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
        <button
          type="button"
          className="btn icon sm ghost"
          aria-label={t('stage.pane.prevPhoto')}
          title={t('stage.pane.prevPhoto')}
          onClick={() => {
            go(-1);
          }}
        >
          <Icon name="back" size={14} />
        </button>
        <span className="mono">{photo.id}</span>
        <span className="mono faint">
          {t('stage.pane.photoCount', { n: index + 1, total: set.items.length })}
        </span>
        <button
          type="button"
          className="btn icon sm ghost"
          aria-label={t('stage.pane.nextPhoto')}
          title={t('stage.pane.nextPhoto')}
          onClick={() => {
            go(1);
          }}
        >
          <Icon name="fwd" size={14} />
        </button>
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
  if (!project || !layer) return null;
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
            {rasters.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <RasterView
        key={layer.id}
        projectId={project.id}
        layer={layer}
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

const ZONE: Record<Exclude<PaneKind, '3d' | 'map'>, 'video' | 'photo' | 'map' | 'report'> = {
  video: 'video',
  photo: 'photo',
  raster: 'map',
  report: 'report',
};

/** A split side that shows something other than the 3D view or the map. */
export function SplitPane({ side, split }: { side: Side; split: SplitModel }) {
  const kind = split.sides[side];
  if (kind === '3d' || kind === 'map') return null;
  return (
    <FocusZone
      kind={ZONE[kind]}
      className={`pane pane-x pane-${kind}`}
      data-side={side}
      data-testid={`pane-${kind}`}
    >
      {kind === 'video' ? (
        <VideoPane />
      ) : kind === 'photo' ? (
        <PhotoPane />
      ) : kind === 'raster' ? (
        <RasterPane split={split} side={side} />
      ) : (
        <ReportPane split={split} />
      )}
      <PaneChooser side={side} split={split} />
    </FocusZone>
  );
}
