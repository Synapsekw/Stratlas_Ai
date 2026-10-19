/**
 * The confirm box of "Compare with previous survey" on one polygon: the two dates, an opt-in
 * "Include volumes (cut and fill)" remembered per computer, and Compare. It starts the area runs
 * (`runAreaCompare`); a start error stays in the box, notes become toasts.
 */
import { formatDate, Icon, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef, useState } from 'react';
import { toastHost } from '../../shell/actions/toastHost';
import { frameOf } from '../../survey/measureScene';
import { useMeasure } from '../../survey/measureStore';
import '../../survey/measure.css';
import { surfacePair } from '../producers/raster';
import { appProducerDeps, pairContext } from '../producers/register';
import {
  areaCompare,
  setVolumesPref,
  useAreaCompare,
  volumesPref,
  type AreaCompareRequest,
} from './areaCompareStore';
import { areaScope, polygonRing } from './areaModel';
import { runAreaCompare } from './run';

/** Mounted once beside the other app dialogs: shows the box while a request is open. */
export function AreaCompareHost() {
  const request = useAreaCompare((s) => s.request);
  if (!request) return null;
  return (
    <AreaCompareDialog
      key={`${request.measurementId}:${request.from}:${request.to}`}
      request={request}
    />
  );
}

export function AreaCompareDialog({ request }: { request: AreaCompareRequest }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const m = useMeasure((s) => s.file.measurements.find((x) => x.id === request.measurementId));
  const [wanted, setWanted] = useState(volumesPref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    areaCompare.getState().close();
  };
  useFocusTrap(ref, true, { onEscape: close });

  const ctx = project ? pairContext(project.id, request.from, request.to) : null;
  const surfaces = ctx ? surfacePair(ctx) : null;
  const noVolumes = typeof surfaces === 'string' ? surfaces : null;
  const dateOf = (id: string) => {
    const c = project?.manifest.captures.find((x) => x.id === id);
    return formatDate(c?.date ?? id);
  };
  // the name the area is stored under (a blank label falls back to the id)
  const name = m ? areaScope(m).name : request.measurementId;

  const run = async () => {
    if (!m || !project || !ctx) {
      setError(t('actions.measure.notFound'));
      return;
    }
    const ring = polygonRing(m, frameOf(project.manifest).epsg);
    if ('reason' in ring) {
      setError(ring.reason);
      return;
    }
    const volumes = noVolumes === null && wanted;
    if (noVolumes === null) setVolumesPref(wanted);
    setBusy(true);
    setError(null);
    const scope = areaScope(m);
    const r = await runAreaCompare(appProducerDeps(), ctx, { scope, ring: ring.ring }, { volumes });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    close();
    const host = toastHost(scope.name);
    host.note(
      t('change.area.started', {
        name: scope.name,
        from: dateOf(request.from),
        to: dateOf(request.to),
      }),
    );
    for (const n of r.notes) host.note(n, true);
  };

  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="area-compare-title"
      data-testid="area-compare-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="sv-dialog" style={{ width: 'min(400px, 100%)' }}>
        <header className="sv-head" role="none">
          <Icon name="split" size={16} />
          <h2 id="area-compare-title">{t('change.area.title')}</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="small faint" data-testid="area-compare-name">
          {name}
        </p>
        <p className="small" data-testid="area-compare-dates">
          {t('change.area.dates', { from: dateOf(request.from), to: dateOf(request.to) })}
        </p>
        <div>
          <label className="sv-check" title={noVolumes ?? undefined}>
            <input
              type="checkbox"
              data-testid="area-compare-volumes"
              checked={noVolumes === null && wanted}
              disabled={noVolumes !== null || busy}
              onChange={(e) => {
                setWanted(e.target.checked);
              }}
            />
            {t('change.area.volumes')}
          </label>
          {noVolumes && (
            <p className="small faint" data-testid="area-compare-volumes-reason">
              {noVolumes}
            </p>
          )}
        </div>
        {error && (
          <p className="notice danger small" role="alert" data-testid="area-compare-error">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        <footer className="sv-foot" role="none">
          <span className="sv-grow" />
          <button
            type="button"
            className="btn sm ghost"
            data-testid="area-compare-cancel"
            onClick={close}
          >
            {t('change.area.cancel')}
          </button>
          <button
            type="button"
            className="btn sm primary"
            data-testid="area-compare-run"
            disabled={busy || !m}
            aria-busy={busy}
            onClick={() => {
              void run();
            }}
          >
            {t('change.area.run')}
          </button>
        </footer>
      </div>
    </div>
  );
}
