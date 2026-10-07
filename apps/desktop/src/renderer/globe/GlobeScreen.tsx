import { reducedMotion } from '@aio/engine';
import {
  creditLines,
  formatArea,
  formatLength,
  globeToSite,
  issuePins,
  lastCapture,
  pathLength,
  polygonArea,
  selectPacks,
  sortSites,
  type GlobeCamera,
  type SiteGeoref,
} from '@aio/globe';
import {
  GlobeView,
  type GlobeController,
  type GlobePick,
  type GlobeTilesets,
} from '@aio/globe/view';
import {
  defaultGlobeSettings,
  type GlobeSettings,
  type GlobeSite,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';
import { t, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useGraphics } from '../graphics';
import { bridge, shell, useShell } from '../shell';
import './globe.css';

/** Where the renderer build serves its copy of Cesium (electron.vite.config.ts `cesiumAssets`). */
const CESIUM_BASE = new URL('cesium/', document.baseURI).href;

/** The Globe camera when it last closed, so coming back shows the same view (this session). */
let lastCamera: GlobeCamera | null = null;

/** How a manifest sits on the Earth, for issue pins and the hand-off (heights as ellipsoidal). */
export function georefOf(m: Pick<ProjectManifest, 'crs' | 'origin'>): SiteGeoref {
  return { crs: m.crs, origin: m.origin, heightOffset: 0 };
}

interface Loaded {
  sites: GlobeSite[];
  imagery: RasterPackInfo[];
  terrain: RasterPackInfo[];
  settings: GlobeSettings;
  error: string | null;
}

function useGlobeData(): Loaded | null {
  const [data, setData] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      bridge.call('globe:sites', {}),
      bridge.call('globe:packs', {}),
      bridge.call('globe:getSettings', {}),
    ]).then(([s, p, g]) => {
      if (!live) return;
      const sites = s.ok && s.value.ok ? s.value.sites : [];
      const packs = p.ok && p.value.ok ? p.value : { imagery: [], terrain: [] };
      const settings = g.ok && g.value.ok ? g.value.settings : defaultGlobeSettings();
      const error = !s.ok ? s.error : !s.value.ok ? s.value.error : null;
      setData({ sites: sortSites(sites), ...packs, settings, error });
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** The Globe screen (M10 G6): loaded lazily, so CesiumJS costs nothing until it opens. */
export default function GlobeScreen() {
  useT();
  const tier = useGraphics((s) => s.tier);
  const library = useShell((s) => s.library);
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const loaded = useGlobeData();
  const [settings, setSettings] = useState<GlobeSettings | null>(null);
  const [pick, setPick] = useState<GlobePick | null>(null);
  const [ctl, setCtl] = useState<GlobeController | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measured, setMeasured] = useState<[number, number][]>([]);
  const prefs = settings ?? loaded?.settings ?? defaultGlobeSettings();

  const imagery = useMemo(
    () => selectPacks(loaded?.imagery ?? [], prefs.imagery),
    [loaded, prefs.imagery],
  );
  const terrain = useMemo(
    () => selectPacks(loaded?.terrain ?? [], prefs.terrain ?? 'auto'),
    [loaded, prefs.terrain],
  );
  const [tilesets, setTilesets] = useState<GlobeTilesets | null>(null);
  useEffect(() => {
    let live = true;
    if (!project) return;
    // the open project's 3D Tiles (G7's `tilesets:list`; none until it answers)
    void bridge.call('tilesets:list', { projectId: project.id }).then((r) => {
      if (!live) return;
      setTilesets(
        r.ok && r.value.ok
          ? {
              projectId: project.id,
              georef: georefOf(project.manifest),
              entries: r.value.file.entries,
            }
          : null,
      );
    });
    return () => {
      live = false;
    };
  }, [project]);
  const pins = useMemo(() => {
    if (!project || prefs.showIssues === false) return null;
    return {
      projectId: project.id,
      georef: georefOf(project.manifest),
      pins: issuePins(issues, project.manifest),
    };
  }, [project, issues, prefs.showIssues]);
  const [credits, setCredits] = useState<string[]>(() => creditLines([]));

  const save = (next: GlobeSettings) => {
    setSettings(next);
    void bridge.call('globe:setSettings', { settings: next });
  };

  /** Open a library project in the site view, at the Globe's camera; then select an issue. */
  const openSite = async (projectId: string, issueId?: string) => {
    const entry = library?.find((e) => e.id === projectId);
    const camera = ctl?.camera();
    if (!entry) return;
    setBusy(projectId);
    if (workspace.getState().project?.id !== projectId)
      await shell.getState().openProject(entry.path);
    setBusy(null);
    const opened = workspace.getState().project;
    if (!opened) return;
    if (camera && !issueId)
      shell.getState().saveView(opened.id, globeToSite(camera, georefOf(opened.manifest)));
    if (issueId) workspace.getState().select({ kind: 'issue', id: issueId });
    shell.getState().go('scene');
  };

  if (!loaded) return <section className="globe-screen" aria-busy="true" />;

  const site = pick ? loaded.sites.find((s) => s.projectId === pick.projectId) : undefined;
  const issue =
    pick?.kind === 'issue' && project?.id === pick.projectId
      ? issues.find((i) => i.id === pick.issueId)
      : undefined;
  const start = lastCamera
    ? { camera: lastCamera }
    : project
      ? (() => {
          const s = loaded.sites.find((x) => x.projectId === project.id);
          return s ? { site: s.lonLat } : null;
        })()
      : null;

  return (
    <section className="globe-screen" aria-label={t('globe.nav')} data-testid="globe-screen">
      <GlobeView
        baseUrl={CESIUM_BASE}
        tier={tier}
        sites={loaded.sites}
        imagery={imagery}
        terrain={terrain}
        exaggeration={prefs.terrainExaggeration ?? 1}
        issuePins={pins}
        tilesets={tilesets && tilesets.projectId === project?.id ? tilesets : null}
        start={start}
        reducedMotion={reducedMotion}
        onPick={setPick}
        onCredits={setCredits}
        measuring={measuring}
        onMeasure={setMeasured}
        onReady={setCtl}
        onClose={(c) => {
          lastCamera = c;
        }}
      />
      <aside className="globe-panel" aria-label={t('globe.sites')}>
        <h1 className="globe-title">{t('globe.nav')}</h1>
        {loaded.error && <p className="globe-error">{loaded.error}</p>}
        {loaded.sites.length === 0 ? (
          <p className="globe-empty">{t('globe.noSites')}</p>
        ) : (
          <ul className="globe-sites" data-testid="globe-sites">
            {loaded.sites.map((s) => (
              <li key={s.projectId}>
                <button
                  type="button"
                  className="globe-site"
                  aria-current={pick?.projectId === s.projectId ? 'true' : undefined}
                  onClick={() => {
                    setPick({ kind: 'site', projectId: s.projectId });
                    void ctl?.flyToSite(s.lonLat);
                  }}
                >
                  <span className="name">{s.name}</span>
                  <span className="meta">
                    {[
                      lastCapture(s) ?? t('globe.noCapture'),
                      t('globe.openIssues', { count: s.issues.open }),
                    ].join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="globe-field">
          <span>{t('globe.imagery')}</span>
          <select
            value={prefs.imagery ?? 'auto'}
            onChange={(e) => {
              save({ ...prefs, imagery: e.target.value });
            }}
          >
            <option value="auto">{t('globe.imageryAuto')}</option>
            {loaded.imagery.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="globe-field">
          <span>{t('globe.terrain')}</span>
          <select
            value={prefs.terrain ?? 'auto'}
            disabled={tier === 'low'}
            onChange={(e) => {
              save({ ...prefs, terrain: e.target.value });
            }}
          >
            <option value="auto">{t('globe.terrainAuto')}</option>
            <option value="off">{t('globe.terrainOff')}</option>
            {loaded.terrain.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {tier === 'low' && <p className="globe-note">{t('globe.lowTier')}</p>}
        <div className="globe-measure">
          <button
            type="button"
            className={`btn sm${measuring ? '' : ' ghost'}`}
            aria-pressed={measuring}
            onClick={() => {
              setMeasuring(!measuring);
              setPick(null);
            }}
          >
            {t('globe.measure')}
          </button>
          {measuring && (
            <p className="globe-readout" data-testid="globe-readout" aria-live="polite">
              {measured.length < 2
                ? t('globe.measureHint')
                : [
                    t('globe.distance', { value: formatLength(pathLength(measured)) }),
                    ...(measured.length >= 3
                      ? [t('globe.area', { value: formatArea(polygonArea(measured)) })]
                      : []),
                  ].join(' · ')}
            </p>
          )}
        </div>
        <label className="globe-check">
          <input
            type="checkbox"
            checked={prefs.showIssues !== false}
            onChange={(e) => {
              save({ ...prefs, showIssues: e.target.checked });
            }}
          />
          <span>{t('globe.showIssues')}</span>
        </label>
      </aside>
      {site && (
        <div className="globe-card" role="dialog" aria-label={site.name} data-testid="globe-card">
          {issue ? (
            <>
              <h2>
                {issue.code} {issue.title}
              </h2>
              <p className="meta">
                {t('globe.issueMeta', {
                  severity: String(issue.severity),
                  status: issue.status,
                })}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null}
                  onClick={() => void openSite(site.projectId, issue.id)}
                >
                  {t('globe.openIssue')}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>{site.name}</h2>
              <p className="meta">
                {[
                  lastCapture(site) ?? t('globe.noCapture'),
                  t('globe.openIssues', { count: site.issues.open }),
                  t('globe.tilesets', { count: site.tilesets.length }),
                ].join(' · ')}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => void ctl?.flyToSite(site.lonLat)}
                >
                  {t('globe.flyTo')}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null || !library?.some((e) => e.id === site.projectId)}
                  onClick={() => void openSite(site.projectId)}
                >
                  {t('globe.openSite')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <footer className="globe-credits" data-testid="globe-credits" aria-label={t('globe.credits')}>
        {credits.map((c) => (
          <span key={c}>{c}</span>
        ))}
        <span>CesiumJS (Apache-2.0)</span>
      </footer>
    </section>
  );
}
