import type { Bbox } from '@aio/maps';
import { formatBytes, Icon, Switch, t, type IconName } from '@aio/ui';
import { useState } from 'react';
import type { QueueResult } from '../../mapCoverage/offer';
import {
  chosenRegions,
  totalBytes,
  type CoverageSummary,
  type PlannedKind,
  type PlannedRegion,
} from '../../mapCoverage/plan';
import { useMapCoverage } from '../../mapCoverage/store';

const KIND_ICON: Record<PlannedKind, IconName> = {
  site: 'target',
  country: 'map',
  area: 'map',
  world: 'globe',
};

/** "3 of 7 projects have no detailed street map", or that all of them have one. */
function summaryText(s: CoverageSummary): string {
  if (s.total === 0) return t('maps.coverage.noProjects');
  if (s.located === 0) return t('maps.coverage.nonePlaced');
  if (s.missing === 0) return t('maps.coverage.allDetailed', { count: s.located });
  return t('maps.coverage.missing', { count: s.missing, total: s.total });
}

export interface ProjectMapsProps {
  offlineOnly: boolean;
  /** Show an area on the coverage map of the page. */
  onShow: (bbox: Bbox) => void;
  /** Downloads started, or a pack was removed: the page reads its lists again. */
  onChanged: () => void;
  /** The page's Remove flow: the pack waiting for its confirmation, and the removal itself. */
  confirm: string | null;
  setConfirm: (id: string | null) => void;
  remove: (id: string) => Promise<void>;
}

/**
 * "Maps for your projects": which projects have no detailed street map, and the areas that
 * would give them one (a box around each site, an overview of its country, the world overview),
 * each with its estimated size and a checkbox, and one Download that queues them in Downloads.
 * It also offers to remove the packs of an earlier plan that cover no project any more, and
 * holds the two preferences. Nothing is downloaded until Download is pressed (or, for a new
 * project, with the automatic preference on), and nothing at all when offline-only.
 */
export function ProjectMaps({
  offlineOnly,
  onShow,
  onChanged,
  confirm,
  setConfirm,
  remove,
}: ProjectMapsProps) {
  const c = useMapCoverage();
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueueResult | null>(null);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const { regions } = c.plan;
  const chosen = chosenRegions(c.plan, leftOut);
  const total = formatBytes(totalBytes(chosen));
  const names = new Map(c.projects.map((p) => [p.id, p.name]));

  const forText = (r: PlannedRegion) => {
    if (r.kind === 'world') return t('maps.coverage.for.world');
    if (r.kind === 'site' || r.projects.length === 1)
      return r.projects.map((id) => names.get(id) ?? id).join(', ');
    return t('maps.coverage.for.projects', { count: r.projects.length });
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(leftOut);
    if (on) next.delete(id);
    else next.add(id);
    setLeftOut(next);
  };

  const download = async () => {
    setBusy(true);
    const r = await c.download(chosen);
    setBusy(false);
    setResult(r);
    onChanged();
  };

  const setPref = async (patch: { offer?: boolean; auto?: boolean }) => {
    setPrefError(await c.setPrefs(patch));
  };

  return (
    <div className="sblock" data-testid="project-maps">
      <h2>
        {t('maps.coverage.title')}{' '}
        <span className="sub" data-testid="project-maps-summary">
          {c.loaded ? summaryText(c.summary) : ''}
        </span>
      </h2>
      <p className="help">{t('maps.coverage.text')}</p>
      {offlineOnly && (
        <p className="notice warn" role="note" data-testid="project-maps-offline">
          <Icon name="offline" size={14} />
          <span>{t('maps.coverage.offlineOnly')}</span>
        </p>
      )}
      {c.error && (
        <p className="notice warn" role="alert">
          <Icon name="warn" size={14} />
          {t('maps.coverage.error', { error: c.error })}
        </p>
      )}
      {!c.loaded && <div className="skel-line" />}
      {c.loaded && c.placesKnown && regions.length === 0 && (
        <p className="notice ok" role="status" data-testid="project-maps-covered">
          <Icon name="check" size={14} />
          {t(c.summary.located > 0 ? 'maps.coverage.covered' : 'maps.coverage.coveredNoProjects')}
        </p>
      )}
      {c.loaded && regions.length > 0 && (
        <>
          <table className="tbl pm-plan" data-testid="project-maps-plan">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">{t('maps.coverage.col.include')}</span>
                </th>
                <th>{t('maps.coverage.col.area')}</th>
                <th>{t('maps.coverage.col.for')}</th>
                <th>{t('maps.coverage.col.detail')}</th>
                <th>{t('maps.coverage.col.size')}</th>
                <th>
                  <span className="sr-only">{t('maps.coverage.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr key={r.id} data-kind={r.kind} data-testid="project-maps-region">
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('maps.coverage.include', { label: r.label })}
                      checked={!r.busy && !leftOut.has(r.id)}
                      disabled={r.busy || busy}
                      onChange={(e) => {
                        toggle(r.id, e.target.checked);
                      }}
                    />
                  </td>
                  <td>
                    <div className="cell-h">
                      <Icon name={KIND_ICON[r.kind]} size={14} className="faint" />
                      <b className="hi" dir="auto">
                        {r.label}
                      </b>
                    </div>
                  </td>
                  <td dir="auto">{forText(r)}</td>
                  <td className="nowrap">
                    {t(`maps.coverage.detail.${r.kind}`, { zoom: r.maxZoom })}
                  </td>
                  <td className="mono nowrap">
                    {r.busy
                      ? t('maps.coverage.inDownloads')
                      : t('maps.coverage.about', { size: formatBytes(r.estimate.bytes) })}
                  </td>
                  <td className="nowrap pack-acts">
                    {r.kind !== 'world' && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          onShow(r.bbox);
                        }}
                      >
                        {t('maps.coverage.show')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td colSpan={3}>{t('maps.coverage.total', { count: chosen.length })}</td>
                <td className="mono nowrap" data-testid="project-maps-total">
                  <b className="hi">
                    {chosen.length > 0
                      ? t('maps.coverage.about', { size: total })
                      : t('maps.coverage.totalNone')}
                  </b>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          {result?.failed.map((f) => (
            <p key={f.id} className="prov-err" role="alert">
              {t('maps.offer.failed', { label: f.label, error: f.error })}
            </p>
          ))}
          <div className="ar-acts pm-acts">
            <span className="help">{t('maps.coverage.host')}</span>
            <button
              type="button"
              className="btn primary"
              disabled={offlineOnly || busy || chosen.length === 0}
              onClick={() => void download()}
            >
              <Icon name="download" size={14} />
              {chosen.length > 0
                ? t('maps.coverage.download', { size: total })
                : t('maps.coverage.downloadNone')}
            </button>
          </div>
        </>
      )}
      {c.loaded && c.summary.noLocation > 0 && (
        <p className="help pm-note" data-testid="project-maps-unplaced">
          {t('maps.coverage.unplaced', { count: c.summary.noLocation })}
        </p>
      )}
      {c.orphans.length > 0 && (
        <div className="pm-orphans" data-testid="project-maps-orphans">
          <p className="notice online" role="note">
            <Icon name="map" size={14} />
            <span>{t('maps.coverage.orphans', { count: c.orphans.length })}</span>
            <button
              type="button"
              className="btn sm"
              aria-expanded={reviewing}
              onClick={() => {
                setReviewing(!reviewing);
              }}
            >
              {t('maps.coverage.orphans.review')}
            </button>
          </p>
          {reviewing &&
            c.orphans.map((p) => (
              <div key={p.id} className="pm-orphan">
                <Icon name="globe" size={14} className="faint" />
                <b className="hi" dir="auto">
                  {p.label}
                </b>
                <span className="mono faint">{formatBytes(p.sizeBytes)}</span>
                <span className="pack-acts">
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      onShow([...p.bbox] as Bbox);
                    }}
                  >
                    {t('maps.coverage.show')}
                  </button>
                  {confirm === p.id ? (
                    <>
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => void remove(p.id).then(() => c.refresh())}
                      >
                        {t('maps.coverage.orphans.remove', { label: p.label })}
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          setConfirm(null);
                        }}
                      >
                        {t('maps.coverage.orphans.keep')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        setConfirm(p.id);
                      }}
                    >
                      {t('settings.maps.remove')}
                    </button>
                  )}
                </span>
              </div>
            ))}
        </div>
      )}
      <div className="pm-prefs">
        <div className="opt">
          <b>{t('maps.coverage.pref.auto')}</b>
          <span>
            {t(
              offlineOnly
                ? 'maps.coverage.pref.auto.offline'
                : c.prefs.auto
                  ? 'maps.coverage.pref.auto.on'
                  : 'maps.coverage.pref.auto.off',
            )}
          </span>
          <Switch
            checked={c.prefs.auto}
            label={t('maps.coverage.pref.auto')}
            onChange={(v) => void setPref({ auto: v })}
          />
        </div>
        <div className="opt">
          <b>{t('maps.coverage.pref.offer')}</b>
          <span>{t('maps.coverage.pref.offer.text')}</span>
          <Switch
            checked={c.prefs.offer}
            label={t('maps.coverage.pref.offer')}
            onChange={(v) => void setPref({ offer: v })}
          />
        </div>
        {prefError && (
          <p className="prov-err" role="alert">
            {t('maps.coverage.pref.failed', { error: prefError })}
          </p>
        )}
      </div>
    </div>
  );
}
