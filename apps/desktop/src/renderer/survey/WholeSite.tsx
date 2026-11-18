/**
 * Whole-site cut and fill (M11 G4): any two surfaces compared over their overlap by the pipeline
 * (`survey.compare` in site mode, a job: the difference grid, its heat map pyramid and contours),
 * its totals and heat map, and draft cut and fill regions (Propeller's volume breakdown without a
 * model) that a person ticks and accepts as polygon measurements. A draft is only a suggestion:
 * the accepted measurement computes its own exact volumes. The dialog is named for the one thing
 * only it does, "Find cut and fill regions": the totals between two surveys are in Project >
 * Volumes > Cut & fill, and a line here says so. Its text is in the catalogue (`siteRegions`);
 * the names written into the measurements it keeps (label, folder, comparison) are stored data
 * and stay as they were.
 */
import { formatQuantity } from '@aio/geo';
import {
  ComparisonResult,
  type PickedOn,
  type SitePoint,
  type SurfaceRef,
  type SurveyMeasurement,
} from '@aio/schema';
import { deadbandFromStops, draftRegions, sideKey, sideOptions } from '@aio/survey';
import { Dialog, EmptyState, t as say, useT } from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { authorName } from '../author';
import { bridge } from '../shell';
import { timeline } from '../workspace/timeline';
import {
  compareStore,
  engineClient,
  openCompareDialog,
  patchSite,
  setSite,
  useCompare,
  type SiteTiles,
} from './compareStore';
import { magicStatus, projectOutline, unavailableText } from './MagicPolygon';
import { storedFromPrepared } from './dateSurfaces';
import { creationDating } from './measureSource';
import { addMeasurement, measureStore, newMeasurementId, useMeasure } from './measureStore';
import { snapRegion } from './snapRegions';

const MAX_SITE_CELLS = 1_000_000;

/** A new output folder for a whole-site job. */
function siteOut(): string {
  return `survey/compare/site-${Date.now().toString(36)}`;
}

async function readJson(projectId: string, path: string): Promise<unknown> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) throw new Error(say('siteRegions.unreadable', { path, status: r.status }));
  return (await r.json()) as unknown;
}

export function WholeSite() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const surfaces = useCompare((s) => s.surfaces);
  const designs = useCompare((s) => s.designs);
  const captures = useCompare((s) => s.captures);
  const root = useCompare((s) => s.root);
  const site = useCompare((s) => s.site);
  const options = useMemo(
    () => sideOptions({ surfaces, captures, designs }).filter((o) => o.group !== 'Bases'),
    [surfaces, captures, designs],
  );
  const [from, setFrom] = useState<SurfaceRef>(site?.from ?? { kind: 'previous' });
  const [to, setTo] = useState<SurfaceRef>(site?.to ?? { kind: 'current' });
  const stopsDb = deadbandFromStops(settings.heatmap.stops);
  const [useDb, setUseDb] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** Drafts whose boundary the model snapped to the ortho, and the line said after a snap. */
  const [snapped, setSnapped] = useState<Set<number>>(() => new Set());
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [snapping, setSnapping] = useState(false);
  const close = () => {
    openCompareDialog(null);
  };
  const units = settings.units;
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision);
  const a = (x: number) => formatQuantity(x, 'area', units, settings.precision);
  const projectId = project?.id ?? null;

  const findRegions = async () => {
    const s = compareStore.getState().site;
    if (!s) return;
    const bounds = surfaces.map((x) => x.bounds);
    const span = bounds.length ? Math.max(...bounds.map((b) => (b[3] - b[0]) * (b[4] - b[1]))) : 0;
    const finest = Math.min(...surfaces.map((x) => x.cellM), 1);
    const cellM = Math.max(finest, Math.sqrt(span / MAX_SITE_CELLS));
    try {
      const r = await engineClient().site({ from: s.from, to: s.to, cellM }, 'whole-site');
      const g = r.grid;
      const drafts = g
        ? draftRegions(
            { dz: g.dz, nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, cellM: g.cellM },
            {
              minDepthM: s.deadbandM ?? (stopsDb > 0 ? stopsDb : 0.1),
              minAreaM2: Math.max(4 * g.cellM * g.cellM, 4),
              max: 30,
            },
          )
        : [];
      patchSite({ drafts });
      setPicked(new Set());
      setSnapped(new Set());
      setSnapNote(null);
    } catch (err) {
      patchSite({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  // follow the job; at its end read the result and the heat map index, then find the regions
  const job = site?.job ?? null;
  useEffect(() => {
    const aio = window.aio as typeof window.aio | undefined;
    if (!job || !aio || !projectId) return;
    return aio.on('jobs:event', (e) => {
      if (e.type !== 'update' || e.job.id !== job) return;
      patchSite({ progress: e.job.progress });
      if (e.job.status === 'failed' || e.job.status === 'cancelled') {
        patchSite({ job: null, error: e.job.error ?? t('siteRegions.stopped') });
        return;
      }
      if (e.job.status !== 'done') return;
      void (async () => {
        const out = compareStore.getState().site?.out ?? '';
        try {
          const res = (await readJson(projectId, `${out}/result.json`)) as { result: unknown };
          const result = ComparisonResult.parse(res.result);
          let tiles: SiteTiles | null = null;
          try {
            tiles = (await readJson(projectId, `${out}/heat/tiles.json`)) as SiteTiles;
          } catch {
            // a refused comparison writes no heat map
          }
          patchSite({ job: null, result, tiles, progress: 1 });
          await findRegions();
        } catch (err) {
          patchSite({ job: null, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, projectId]);

  const run = async () => {
    setError(null);
    if (!root) return;
    const out = siteOut();
    const deadbandM = useDb && stopsDb > 0 ? stopsDb : null;
    const r = await bridge.call('jobs:start', {
      pipeline: 'survey.compare',
      project: root,
      params: {
        site: { from, to, ...(deadbandM !== null ? { deadbandM } : {}) },
        out,
      },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    setSite({
      job: r.value.job.id,
      progress: 0,
      out,
      from,
      to,
      deadbandM,
      result: null,
      tiles: null,
      drafts: [],
      error: null,
    });
  };

  /** Snap the ticked drafts' boundaries to the ortho with the local model (SAI-2); still drafts. */
  const snap = async () => {
    const s = compareStore.getState().site;
    const outline = projectOutline();
    if (!s || !outline) return;
    setSnapping(true);
    setSnapNote(null);
    try {
      const status = await magicStatus();
      if (!status.available) {
        setSnapNote(
          unavailableText(status).replaceAll('Suggest boundaries', t('siteRegions.snapName')),
        );
        return;
      }
      const drafts = [...s.drafts];
      const done = new Set(snapped);
      const kept: string[] = [];
      for (const k of [...picked].sort((x, y) => x - y)) {
        const d = drafts[k];
        if (!d || done.has(k)) continue;
        const r = await snapRegion(d.ring, outline);
        if (r.snapped) {
          drafts[k] = { ...d, ring: r.ring };
          done.add(k);
        } else
          kept.push(
            t('siteRegions.snapKept', {
              n: k + 1,
              reason: r.reason ?? t('siteRegions.snapKeptAsWas'),
            }),
          );
      }
      patchSite({ drafts });
      setSnapped(done);
      const n = [...picked].filter((k) => done.has(k)).length;
      setSnapNote([t('siteRegions.snapNote', { done: n, picked: picked.size }), ...kept].join(' '));
    } finally {
      setSnapping(false);
    }
  };

  const accept = () => {
    if (!site) return;
    const now = new Date().toISOString();
    const by = authorName();
    const surface = measureStore.getState().surface;
    const height = (e: number, n: number) => surface?.heightAt(e, n) ?? 0;
    // the regions belong to the date of the surface they end on, measured on its DSM
    const manifest = project?.manifest ?? null;
    const to = site.to;
    const prepared = to.kind === 'survey' ? surfaces.find((x) => x.id === to.surface) : undefined;
    const dating = creationDating(
      prepared?.source.kind === 'dsm' ? [{ layer: prepared.source.layer, on: 'ground' }] : [],
      {
        index: workspace.getState().dates,
        manifest: manifest ?? { layers: [] },
        focus: prepared?.capture ?? timeline.getState().focus,
      },
    );
    let n = 0;
    for (const k of [...picked].sort((x, y) => x - y)) {
      const d = site.drafts[k];
      if (!d) continue;
      n++;
      const m: SurveyMeasurement = {
        id: newMeasurementId(),
        family: 'polygon',
        tool: 'volume',
        label: `${d.kind === 'cut' ? 'Cut' : 'Fill'} region ${String(k + 1)}`,
        folder: 'Whole-site regions',
        scope: dating.scope,
        ...(dating.source ? { source: dating.source } : {}),
        // the ring is in the prepared surfaces' frame, not where the date is lined up now
        points: storedFromPrepared(
          d.ring.map(([e, nn]): SitePoint => [e, nn, height(e, nn)]),
          dating.scope,
          manifest,
        ),
        pickedOn: d.ring.map((): PickedOn => 'ground'),
        items: [
          {
            id: `c${String(k + 1)}`,
            label: 'Whole-site change',
            from: site.from,
            to: site.to,
            useDeadband: site.deadbandM !== null,
            ...(site.deadbandM !== null ? { deadbandM: site.deadbandM } : {}),
          },
        ],
        results: [],
        createdAt: now,
        ...(by ? { createdBy: by } : {}),
      };
      addMeasurement(m);
    }
    if (n > 0) {
      patchSite({ drafts: site.drafts.filter((_, k) => !picked.has(k)) });
      setPicked(new Set());
    }
  };

  const pick = (side: 'from' | 'to', value: SurfaceRef, set: (r: SurfaceRef) => void) => (
    <label className="sv-field">
      <span>{t(side === 'from' ? 'siteRegions.from' : 'siteRegions.to')}</span>
      <select
        className="sv-input"
        value={sideKey(value)}
        data-testid={`survey-site-${side}`}
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) set(o.ref);
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.note ? `${o.label} (${o.note})` : o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const res = site?.result ?? null;
  return (
    <Dialog
      open
      onClose={close}
      title={t('siteRegions.title')}
      testId="survey-site"
      description={t('siteRegions.description')}
    >
      {/* the totals have their own home: this dialog is for the regions */}
      <p className="small faint" data-testid="survey-site-totals-hint">
        {t('siteRegions.totalsHint')}
      </p>
      {surfaces.length === 0 && (
        <p className="notice warn small">{t('siteRegions.needSurfaces')}</p>
      )}
      <div className="sv-row sv-wrap">
        {pick('from', from, setFrom)}
        {pick('to', to, setTo)}
      </div>
      <label className="sv-check">
        <input
          type="checkbox"
          checked={useDb}
          disabled={stopsDb <= 0}
          onChange={(e) => {
            setUseDb(e.target.checked);
          }}
        />
        {t('siteRegions.deadband', {
          value: formatQuantity(stopsDb, 'distance', units, settings.precision),
        })}
      </label>
      <div className="sv-row">
        <button
          type="button"
          className="btn sm primary"
          disabled={readOnly || surfaces.length === 0 || job !== null}
          data-testid="survey-site-run"
          onClick={() => {
            void run();
          }}
        >
          {job
            ? t('siteRegions.comparing', { percent: Math.round((site?.progress ?? 0) * 100) })
            : t('siteRegions.compare')}
        </button>
      </div>
      {(error ?? site?.error) && (
        <p className="notice danger small" role="alert">
          {error ?? site?.error}
        </p>
      )}
      {res && (
        <table className="sv-readout" data-testid="survey-site-result">
          <caption className="sr-only">{t('siteRegions.result')}</caption>
          <tbody>
            <tr>
              <th scope="row">{t('siteRegions.cut')}</th>
              <td className="mono">{v(res.cutM3)}</td>
              <td className="mono faint">{a(res.areaCutM2)}</td>
            </tr>
            <tr>
              <th scope="row">{t('siteRegions.fill')}</th>
              <td className="mono">{v(res.fillM3)}</td>
              <td className="mono faint">{a(res.areaFillM2)}</td>
            </tr>
            <tr>
              <th scope="row">{t('siteRegions.net')}</th>
              <td className="mono">{v(res.netM3)}</td>
              <td />
            </tr>
            <tr>
              <th scope="row">{t('siteRegions.total')}</th>
              <td className="mono">{v(res.totalM3)}</td>
              <td className="mono faint">{a(res.areaM2)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {res?.status === 'partial' && (
        <p className="notice warn small">
          {t('siteRegions.partial', { reason: res.reason ?? '' })}
        </p>
      )}
      {site && site.drafts.length > 0 && (
        <fieldset className="sv-sub" data-testid="survey-site-drafts">
          <legend>{t('siteRegions.drafts')}</legend>
          <ul className="sv-items">
            {site.drafts.map((d, k) => (
              <li key={k}>
                <label className="sv-check">
                  <input
                    type="checkbox"
                    checked={picked.has(k)}
                    data-testid="survey-site-draft"
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      setPicked(next);
                    }}
                  />
                  {t(d.kind === 'cut' ? 'siteRegions.draftCut' : 'siteRegions.draftFill', {
                    n: k + 1,
                    volume: v(d.volumeM3),
                    area: a(d.areaM2),
                  })}
                  {snapped.has(k) && <span className="faint"> {t('siteRegions.snapped')}</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="sv-row">
            <button
              type="button"
              className="btn sm"
              disabled={readOnly || picked.size === 0}
              data-testid="survey-site-accept"
              onClick={accept}
            >
              {picked.size > 0
                ? t('siteRegions.keep', { count: picked.size })
                : t('siteRegions.keepNone')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={picked.size === 0 || snapping}
              data-testid="survey-site-snap"
              title={t('siteRegions.snapTip')}
              onClick={() => {
                void snap();
              }}
            >
              {snapping ? t('siteRegions.snapping') : t('siteRegions.snap')}
            </button>
          </div>
          {snapNote && (
            <p className="small" role="status" data-testid="survey-site-snap-note">
              {snapNote}
            </p>
          )}
        </fieldset>
      )}
      {site && res && site.drafts.length === 0 && !job && (
        <EmptyState title={t('empty.wholeSite.title')} />
      )}
    </Dialog>
  );
}
