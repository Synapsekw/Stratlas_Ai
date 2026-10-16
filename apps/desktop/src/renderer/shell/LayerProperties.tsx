import { useAnnotateReadOnly } from '@aio/annotate';
import { localToProject, toWgs84 } from '@aio/geo';
import type { LayerInfo } from '@aio/schema';
import { Icon, formatBytes, formatCount, formatDate, useFocusTrap, useT } from '@aio/ui';
import { volumetric } from '@aio/volumetric';
import { captureIndex, useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { dropToGround } from '../builder/dropSession';
import { droppable } from '../builder/dropToGround';
import { useShell } from '../shell';
import { volumeHints } from '../workspace/compare';
import { layerCapture } from '../workspace/framesModel';
import { readLayerInfo, revealLayer } from './layerInfo';
import { renameRequest } from './renameRequest';

type Open = { kind: 'layer'; layerId: string } | { kind: 'project' } | null;

interface LayerPropsState {
  open: Open;
  openLayer(id: string): void;
  openProject(): void;
  close(): void;
}

/** Which Properties dialog is open: a dataset's, the project's, or none. */
export const layerProps = createStore<LayerPropsState>()((set) => ({
  open: null,
  openLayer: (id) => {
    set({ open: { kind: 'layer', layerId: id } });
  },
  openProject: () => {
    set({ open: { kind: 'project' } });
  },
  close: () => {
    set({ open: null });
  },
}));

const MAX_FILES = 8;
const num = (v: number) => String(Math.round(v * 10) / 10);

function crsText(crs: LayerInfo['crs']): string {
  if ('epsg' in crs) return `EPSG:${crs.epsg}`;
  return /^\w+\["([^"]+)"/.exec(crs.wkt)?.[1] ?? crs.wkt.slice(0, 40);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Largest height offset the manifest accepts, in metres. */
const MAX_OFFSET_M = 2000;

/** The typed height offset, or null when it is not a number within +-2000 m. */
function parseOffset(text: string): number | null {
  if (text.trim() === '') return null;
  const v = Number(text);
  return Number.isFinite(v) && Math.abs(v) <= MAX_OFFSET_M ? v : null;
}

/** The height offset row of a point cloud: a number in metres, saved through Drop to ground's undo. */
function OffsetRow({
  layerId,
  current,
  locked,
}: {
  layerId: string;
  current: number;
  locked: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(String(current));
  // follow the manifest: an Undo or a menu drop changes the offset under the open dialog
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setText(String(current));
  }
  const value = parseOffset(text);
  const save = () => {
    if (value === null || locked) return;
    void dropToGround.getState().setOffset(layerId, value === 0 ? null : value);
  };
  return (
    <Row label={t('layerProps.heightOffset')}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          type="number"
          step={0.01}
          min={-MAX_OFFSET_M}
          max={MAX_OFFSET_M}
          value={text}
          disabled={locked}
          aria-label={t('layerProps.heightOffset')}
          aria-invalid={value === null}
          data-testid="layer-props-height-offset"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            save();
          }}
          style={{ width: 110 }}
        />
        <button
          type="button"
          className="btn"
          disabled={locked || value === null}
          onClick={save}
          data-testid="layer-props-height-save"
        >
          {t('layerProps.heightOffsetSave')}
        </button>
      </div>
    </Row>
  );
}

/** Read-only Properties of one dataset or of the project, with Rename and Reveal in folder. */
export function LayerProperties() {
  const open = useStore(layerProps, (s) => s.open);
  if (!open) return null;
  return <PropsDialog key={open.kind === 'layer' ? open.layerId : 'project'} open={open} />;
}

function PropsDialog({ open }: { open: NonNullable<Open> }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const readOnly = useAnnotateReadOnly();
  const dlg = useRef<HTMLDivElement>(null);
  const close = () => {
    layerProps.getState().close();
  };
  useFocusTrap(dlg, true, { onEscape: close });
  const layerId = open.kind === 'layer' ? open.layerId : null;
  const [info, setInfo] = useState<LayerInfo | null>(null);
  const [reading, setReading] = useState(layerId !== null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (layerId === null) return;
    let live = true;
    void readLayerInfo(layerId).then((i) => {
      if (!live) return;
      setInfo(i);
      setReading(false);
    });
    return () => {
      live = false;
    };
  }, [layerId]);
  const gone = layerId !== null && !project?.manifest.layers.some((l) => l.id === layerId);
  useEffect(() => {
    if (gone) layerProps.getState().close();
  }, [gone]);
  if (!project || gone) return null;
  const manifest = project.manifest;
  const layer = layerId ? manifest.layers.find((l) => l.id === layerId) : undefined;
  // the date the tree files it under: its own, else the one its name (or the volumes file) carries
  const captureId = layer
    ? layerCapture(layer, captureIndex(manifest, volumeHints(volumetric.getState())))
    : undefined;
  const capture = manifest.captures.find((c) => c.id === captureId);
  const title =
    open.kind === 'project'
      ? t('layerProps.projectTitle')
      : t('layerProps.title', { name: layer?.name ?? info?.name ?? '' });

  let rows: ReactNode = null;
  if (open.kind === 'project') {
    rows = (
      <>
        <Row label={t('layerProps.name')}>{manifest.name}</Row>
        <Row label={t('layerProps.folder')}>{project.root}</Row>
        <Row label={t('layerProps.crs')}>{crsText(manifest.crs)}</Row>
        <Row label={t('layerProps.origin')}>{manifest.origin.map((v) => num(v)).join(', ')}</Row>
        <Row label={t('layerProps.dates')}>{manifest.captures.length}</Row>
        <Row label={t('layerProps.datasets')}>
          {manifest.layers.filter((l) => l.kind !== 'legacy').length}
        </Row>
      </>
    );
  } else if (layer) {
    const countLabel =
      info?.countKind === 'points'
        ? t('layerProps.points')
        : info?.countKind === 'features'
          ? t('layerProps.features')
          : t('layerProps.items');
    let centre: ReactNode = null;
    if (info?.extent) {
      const { min, max } = info.extent;
      const c: [number, number, number] = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];
      let wgs: string | null = null;
      try {
        if ('epsg' in info.crs) {
          const [lon, lat] = toWgs84(localToProject(c, manifest.origin), info.crs.epsg);
          wgs = t('layerProps.wgs84', { lat: lat.toFixed(7), lon: lon.toFixed(7) });
        }
      } catch {
        wgs = null;
      }
      centre = (
        <Row label={t('layerProps.centre')}>
          <div>{t('layerProps.local', { x: num(c[0]), y: num(c[1]), z: num(c[2]) })}</div>
          {wgs && <div>{wgs}</div>}
        </Row>
      );
    }
    const unknown = t('layerProps.unknown');
    rows = (
      <>
        <Row label={t('layerProps.name')}>{layer.name}</Row>
        <Row label={t('layerProps.kind')}>{t(`layerProps.kind.${layer.kind}`)}</Row>
        <Row label={t('layerProps.date')}>
          {capture ? formatDate(capture.date) : t('actions.noDate')}
        </Row>
        {layer.kind === 'pointcloud' && droppable(layer) === 'ok' && !pkg && (
          <OffsetRow layerId={layer.id} current={layer.heightOffsetM ?? 0} locked={readOnly} />
        )}
        {reading ? (
          <Row label={t('layerProps.files')}>{t('layerProps.reading')}</Row>
        ) : info ? (
          <>
            <Row label={t('layerProps.files')}>
              {info.files.slice(0, MAX_FILES).map((f) => (
                <div key={f.path}>{f.path}</div>
              ))}
              {info.files.length > MAX_FILES && (
                <div>{t('layerProps.moreFiles', { count: info.files.length - MAX_FILES })}</div>
              )}
            </Row>
            <Row label={t('layerProps.size')}>
              {info.bytes === null ? unknown : formatBytes(info.bytes)}
            </Row>
            {info.count !== null && <Row label={countLabel}>{formatCount(info.count)}</Row>}
            {info.extent && (
              <Row label={t('layerProps.extent')}>
                {t('layerProps.extentText', {
                  x: num(info.extent.max[0] - info.extent.min[0]),
                  y: num(info.extent.max[1] - info.extent.min[1]),
                  z: num(info.extent.max[2] - info.extent.min[2]),
                })}
              </Row>
            )}
            {centre}
            <Row label={t('layerProps.crs')}>{crsText(info.crs)}</Row>
            {info.importedAt && (
              <Row label={t('layerProps.imported')}>{formatDate(info.importedAt)}</Row>
            )}
          </>
        ) : (
          <>
            <Row label={t('layerProps.files')}>
              {pkg ? (
                unknown
              ) : (
                <span role="alert" data-testid="layer-props-error">
                  {t('layerProps.failed')}
                </span>
              )}
            </Row>
            <Row label={t('layerProps.size')}>{unknown}</Row>
          </>
        )}
      </>
    );
  }

  return createPortal(
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dlg}
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="layer-props-title"
        data-testid="layer-props"
      >
        <div className="dlg-h">
          <Icon name="layers" size={16} />
          <h2 id="layer-props-title">{title}</h2>
        </div>
        <div className="dlg-b">
          <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
            {rows}
          </dl>
          {error && (
            <p className="notice danger" role="alert" style={{ margin: 0 }}>
              <Icon name="warn" size={14} />
              <span>{error}</span>
            </p>
          )}
        </div>
        <div className="dlg-f">
          {layerId && !pkg && !readOnly && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                close();
                renameRequest.getState().ask(layerId);
              }}
              data-testid="layer-props-rename"
            >
              {t('layerProps.rename')}
            </button>
          )}
          {layerId && !pkg && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setError(null);
                void revealLayer(layerId).then((e) => {
                  setError(e === null ? null : t('layerProps.revealFailed'));
                });
              }}
              data-testid="layer-props-reveal"
            >
              {t('layerProps.reveal')}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={close} data-testid="layer-props-close">
            {t('layerProps.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
