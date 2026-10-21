/**
 * The Thermal bench (thermal analysis M1), the `thermal` workbench tab: one thermal photo of a
 * dataset with its temperatures. From the top: the read-only note (a package or a reviewer), the
 * "Reading temperatures" line while a decode runs, the photo with the temperature under the
 * pointer, the photo's status note when its temperatures are held back (by the decoder, or because
 * its raster is missing or was decoded with settings it no longer has), the palette bar, the
 * settings line with Edit, and the filmstrip of the dataset's thermal photos.
 *
 * Room is kept for the M2 tool rail (above the photo) and the M3 hot-spot list (above the
 * filmstrip). Opening it in a project folder decodes the thermal photos that have no raster yet; a
 * read-only bench never decodes and shows only the rasters that exist.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { thermalPhotoKey, type AssetRef, type ThermalSettings } from '@aio/schema';
import { useT } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useJobs, useShell } from '../../../shell';
import { Filmstrip, type StripPhoto } from '../../../thermal/Filmstrip';
import { PaletteBar } from '../../../thermal/PaletteBar';
import { effectiveSettings, settingsDiffer } from '../../../thermal/settings';
import type { SettingsScope } from '../../../thermal/SettingsEditor';
import { SettingsLine } from '../../../thermal/SettingsLine';
import { ThermalStage } from '../../../thermal/ThermalStage';
import { useThermal } from '../../../thermal/thermalStore';
import '../../../thermal/thermal.css';

const RUNNING = new Set(['starting', 'running', 'cancelling']);
const NONE: ReadonlySet<string> = new Set();

/** The review copy of a photo, for one shown as an ordinary picture; null when it has none. */
function plainUrl(projectId: string, src: AssetRef): string | null {
  try {
    return assetUrl(projectId, src);
  } catch {
    return null;
  }
}

export function ThermalBench() {
  const t = useT();
  const th = useThermal();
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg) !== null;
  const lookOnly = useAnnotateReadOnly();
  const readOnly = pkg || lookOnly || th.readOnly;
  // the photos marked in the filmstrip, for the set they were marked in
  const [marks, setMarks] = useState<{ layerId: string | null; ids: ReadonlySet<string> }>(() => ({
    layerId: null,
    ids: new Set(),
  }));
  const marked: ReadonlySet<string> = marks.layerId === th.layerId ? marks.ids : NONE;

  const layer = useMemo(() => {
    const l = project?.manifest.layers.find((x) => x.id === th.layerId);
    return l?.kind === 'photos' ? l : null;
  }, [project, th.layerId]);

  /** The set's thermal photos in the set's order: the probe's, and any the raster index lists. */
  const photos: StripPhoto[] = useMemo(() => {
    if (!layer) return [];
    const ids = new Set<string>(Object.keys(th.index?.photos ?? {}));
    for (const p of th.probe ?? []) if (p.family !== null) ids.add(p.photoId);
    return layer.items.filter((i) => ids.has(i.id)).map((i) => ({ id: i.id, src: i.src }));
  }, [layer, th.index, th.probe]);

  // decode what has no raster yet once the probe is in (the store asks once per opening and
  // never read-only)
  useEffect(() => {
    if (readOnly || th.probe === null) return;
    void useThermal.getState().decodeMissing();
  }, [readOnly, th.probe]);

  const job = useJobs((s) =>
    s.jobs.find(
      (j) =>
        j.pipeline === 'thermal.decode' && RUNNING.has(j.status) && j.params.layerId === th.layerId,
    ),
  );
  const decodingCount = job
    ? Array.isArray(job.params.photos)
      ? job.params.photos.length
      : photos.length
    : 0;

  const photoId = th.photoId;
  const entry = photoId !== null ? th.index?.photos[photoId] : undefined;
  const probed = th.probe?.find((p) => p.photoId === photoId);
  const model = [probed?.make, probed?.model].filter(Boolean).join(' ') || (entry?.reason ?? '');
  const held = entry !== undefined && entry.status !== 'ok' ? entry.status : null;
  // only the raster of the photo on show: another's may still be there while this one loads
  const loadedHere = held === null && th.currentOf === photoId;
  const raster = loadedHere ? th.current : null;
  // the index says decoded, but the raster is not there or does not read
  const missing = loadedHere && raster === null && entry?.status === 'ok';
  // thermal.json read (or failed): the set's photos are known from here on
  const loaded = th.file !== null || th.error !== null;

  const item = layer?.items.find((i) => i.id === photoId);
  const own =
    th.layerId && photoId !== null
      ? th.file?.photos[thermalPhotoKey(th.layerId, photoId)]?.settings
      : undefined;
  // A raster decoded with settings the photo no longer has (the decode after a save failed or was
  // cancelled) is not this photo's temperatures: they are held back until it is decoded again.
  // A value the camera's SDK clamped differs by design.
  const stale =
    raster !== null &&
    own !== undefined &&
    settingsDiffer(own, raster.meta.settings, raster.meta.clamped);
  const shown = stale ? null : raster;
  const note = held ?? (stale ? 'stale' : missing ? 'missing' : null);

  // What the raster on show was decoded with (the job reads the photo's height, which the
  // renderer cannot see, and the SDK may clamp); else the photo's own settings; else the defaults.
  const settings: ThermalSettings | null =
    shown?.meta.settings ??
    own ??
    (th.layerId && photoId !== null && item
      ? effectiveSettings(th.file, th.layerId, photoId, item.pos ? { pos: item.pos } : {}, null)
      : null);

  const apply = (scope: SettingsScope, patch: Partial<ThermalSettings>) => {
    const layerId = th.layerId;
    if (!layerId || photoId === null) return;
    const ids =
      scope === 'photo' ? [photoId] : scope === 'selected' ? [...marked] : photos.map((p) => p.id);
    void th.saveSettings(
      ids.map((id) => thermalPhotoKey(layerId, id)),
      patch,
    );
  };

  // a tab restored with nothing open: say so rather than show a blank bench
  if (!project || !th.layerId)
    return (
      <div className="wb-scroll th-bench" data-testid="thermal-bench">
        <p className="th-note" data-testid="thermal-status">
          {t('thermal.none')}
        </p>
      </div>
    );

  return (
    <div className="wb-scroll th-bench" data-testid="thermal-bench">
      {readOnly && (
        <p className="th-note th-readonly" role="note" data-testid="thermal-readonly">
          {t('thermal.readOnly')}
        </p>
      )}
      {decodingCount > 0 && (
        <p className="th-progress" role="status" data-testid="thermal-progress">
          <span className="th-progress-dot" aria-hidden="true" />
          {t('thermal.decoding', { count: decodingCount })}
        </p>
      )}
      {th.error && (
        <p className="th-note th-error" role="alert" data-testid="thermal-error">
          {th.error}
        </p>
      )}
      {photos.length === 0 && loaded ? (
        <p className="th-note" data-testid="thermal-status">
          {t('thermal.none')}
        </p>
      ) : (
        <>
          {/* M2: the tool rail and the view switch sit here */}
          <ThermalStage
            raster={shown}
            range={th.range}
            palette={th.palette}
            plain={held === 'unsupported' && item ? plainUrl(project.id, item.src) : null}
          />
          {note !== null && (
            <p className="th-note th-held" role="status" data-testid="thermal-status">
              {t(`thermal.status.${note}`, { model })}
            </p>
          )}
          <PaletteBar
            palette={th.palette}
            range={shown ? th.range : null}
            rangeAuto={th.rangeAuto}
            onPalette={(p) => {
              th.setPalette(p);
            }}
            onAuto={() => {
              th.setRange(null);
            }}
          />
          {settings && (
            <SettingsLine
              settings={settings}
              clamped={shown?.meta.clamped ?? []}
              readOnly={readOnly || held !== null}
              selected={marked.size}
              onApply={apply}
            />
          )}
        </>
      )}
      {/* M3: the hot-spot list sits here */}
      {photos.length > 0 && (
        <Filmstrip
          projectId={project.id}
          photos={photos}
          current={photoId}
          marked={marked}
          onPick={(id, add) => {
            if (add) {
              const next = new Set(marked);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setMarks({ layerId: th.layerId, ids: next });
            }
            void th.select(id);
          }}
        />
      )}
    </div>
  );
}
