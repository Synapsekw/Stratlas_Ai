import { PhotoViewer, VideoAnnotator } from '@aio/annotate';
import type { Layer, ReportFile } from '@aio/schema';
import { Icon, useT, type IconName, type MessageKey } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { FocusZone } from '../FocusZone';
import { PdfViewer } from '../report/PdfViewer';
import { useCall } from '../shell';
import { RasterView } from './RasterPane';
import {
  chooseSide,
  paneOptions,
  resolveSplit,
  takenBy,
  type PaneKind,
  type Side,
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
}

/** The open project's split: which panes it offers and what each side shows (remembered). */
export function useSplit(): SplitModel {
  const project = useWorkspace((s) => s.project);
  const id = project?.id ?? null;
  const listed = useCall('report:list', { projectId: id ?? '' }, id);
  const reports = useMemo(() => (listed?.ok ? listed.value.files : []), [listed]);
  const saved = useStagePrefs((s) => (id ? s.byProject[id]?.split : undefined));
  const options = useMemo(
    () => paneOptions(project?.manifest.layers ?? [], reports.length),
    [project, reports],
  );
  const sides = useMemo(() => resolveSplit(saved, options), [saved, options]);
  return {
    options,
    sides,
    reports,
    set: (next) => {
      if (id) stagePrefs.getState().update(id, { split: next });
    },
  };
}

/** The small selector in a pane's corner: what this side of the split shows. */
export function PaneChooser({ side, split }: { side: Side; split: SplitModel }) {
  const t = useT();
  const current = split.sides[side];
  const taken = takenBy(split.sides, side);
  return (
    <div className={`pane-chooser overlay-box side-${side}`} data-testid={`pane-chooser-${side}`}>
      <Icon name={PANE[current].icon} size={14} className="muted" />
      <select
        className="input"
        aria-label={t(side === 'left' ? 'stage.split.left' : 'stage.split.right')}
        value={current}
        onChange={(e) => {
          split.set(chooseSide(split.sides, side, e.target.value as PaneKind));
        }}
      >
        {split.options.map((k) => (
          <option key={k} value={k} disabled={k === taken}>
            {t(PANE[k].label)}
          </option>
        ))}
      </select>
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

function RasterPane({ split }: { split: SplitModel }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const rasters = (project?.manifest.layers ?? []).filter(
    (l): l is RasterLayer => l.kind === 'raster',
  );
  const layer = rasters.find((l) => l.id === split.sides.raster) ?? rasters[0];
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
      <RasterView key={layer.id} projectId={project.id} layer={layer} />
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
        <RasterPane split={split} />
      ) : (
        <ReportPane split={split} />
      )}
      <PaneChooser side={side} split={split} />
    </FocusZone>
  );
}
