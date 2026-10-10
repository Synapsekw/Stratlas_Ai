import { brand } from '@aio/brand';
import { reducedMotion } from '@aio/engine';
import {
  GLOBE_STYLES,
  formatArea,
  formatLength,
  globeStyleOf,
  globeToSite,
  issuePins,
  lastCapture,
  pathLength,
  planCredits,
  planGlobeLayers,
  polygonArea,
  selectPacks,
  sitesBounds,
  sortSites,
  type GlobeCamera,
  type GlobeStyle,
  type SiteGeoref,
} from '@aio/globe';
import {
  GlobeView,
  type GlobeController,
  type GlobeHover,
  type GlobePick,
  type GlobeTagText,
  type GlobeTilesets,
} from '@aio/globe/view';
import {
  defaultGlobeSettings,
  type GlobeSettings,
  onlineSatelliteAvailability,
  type GlobeSite,
  type MapPackInfo,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';
import { Icon, t, useT, type MessageKey } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGraphics } from '../graphics';
import { bridge, shell, useShell } from '../shell';
import { rasterPacks, useRasterPacks } from '../workspace/siteTiles';
import './globe.css';
import { onGlobeRequest, takeGlobeRequest } from './request';
import { GLOBE_PALETTE, useStreetTiles } from './street';

const LOOK_LABEL: Record<GlobeStyle, MessageKey> = {
  street: 'globe.lookStreet',
  satellite: 'globe.lookSatellite',
  'natural-earth': 'globe.lookNaturalEarth',
};

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
  /** The installed street packs (the Map view's own), drawn as the Globe's street map. */
  street: MapPackInfo[];
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
      bridge.call('packs:list', {}),
    ]).then(([s, p, g, m]) => {
      if (!live) return;
      const sites = s.ok && s.value.ok ? s.value.sites : [];
      const packs = p.ok && p.value.ok ? p.value : { imagery: [], terrain: [] };
      const settings = g.ok && g.value.ok ? g.value.settings : defaultGlobeSettings();
      const error = !s.ok ? s.error : !s.value.ok ? s.value.error : null;
      const street = m.ok ? m.value : [];
      setData({
        sites: sortSites(sites),
        imagery: packs.imagery,
        terrain: packs.terrain,
        street,
        settings,
        error,
      });
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** A site's facts in the list and on its card: its last capture, its open issues, its tilesets. */
function SiteFacts({ site, tilesets }: { site: GlobeSite; tilesets?: boolean }) {
  return (
    <span className="globe-facts">
      <span>{lastCapture(site) ?? t('globe.noCapture')}</span>
      <span data-tone={site.issues.open > 0 ? 'attention' : undefined}>
        {t('globe.openIssues', { count: site.issues.open })}
      </span>
      {tilesets && <span>{t('globe.tilesets', { count: site.tilesets.length })}</span>}
    </span>
  );
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
  const [lit, setLit] = useState<string | null>(null);
  const [ctl, setCtl] = useState<GlobeController | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measured, setMeasured] = useState<[number, number][]>([]);
  const prefs = settings ?? loaded?.settings ?? defaultGlobeSettings();
  const look = globeStyleOf(prefs);

  const imagery = useMemo(
    () => selectPacks(loaded?.imagery ?? [], prefs.imagery),
    [loaded, prefs.imagery],
  );
  const terrain = useMemo(
    () => selectPacks(loaded?.terrain ?? [], prefs.terrain ?? 'auto'),
    [loaded, prefs.terrain],
  );
  const street = useStreetTiles(loaded?.street ?? null, look, tier);
  // online satellite: the person's one switch (the map type menu, Settings, the palette); main
  // holds it and serves or refuses every tile, the Globe only draws the layer while it is on
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const satelliteOn = useRasterPacks((s) => s.prefs.onlineSatellite);
  const online = onlineSatelliteAvailability({ satellite: satelliteOn, offlineOnly }) !== 'off';
  useEffect(() => {
    rasterPacks.getState().refresh();
  }, []);
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
  // what the look credits before the Globe says what it drew
  const [credits, setCredits] = useState<string[]>(() =>
    planCredits(planGlobeLayers({ style: look, street: false, imagery: [] }), ''),
  );

  // the agent's show_on_globe: fly to the site it named, or over the whole library
  useEffect(() => {
    if (!ctl || !loaded) return;
    const serve = () => {
      const req = takeGlobeRequest();
      if (!req) return;
      const s = loaded.sites.find((x) => x.projectId === req.projectId);
      if (s) {
        setPick({ kind: 'site', projectId: s.projectId });
        void ctl.flyToSite(s.lonLat);
      } else {
        setPick(null);
        ctl.flyHome(sitesBounds(loaded.sites));
      }
    };
    serve();
    return onGlobeRequest(serve);
  }, [ctl, loaded]);

  const save = (next: GlobeSettings) => {
    setSettings(next);
    void bridge.call('globe:setSettings', { settings: next });
  };

  /** The words of the label beside a pin: a site's name and state, a cluster's size, an issue. */
  const describe = useCallback(
    (what: GlobeHover): GlobeTagText | null => {
      if (what.kind === 'cluster') return { title: t('globe.cluster', { count: what.count }) };
      if (what.kind === 'issue') {
        const i = project?.id === what.projectId ? issues.find((x) => x.id === what.issueId) : null;
        return i ? { title: `${i.code} ${i.title}` } : null;
      }
      const s = loaded?.sites.find((x) => x.projectId === what.projectId);
      if (!s) return null;
      const captured = lastCapture(s);
      const note =
        s.issues.open > 0 ? t('globe.openIssues', { count: s.issues.open }) : (captured ?? null);
      return note ? { title: s.name, note } : { title: s.name };
    },
    [loaded, project, issues],
  );

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

  if (!loaded) return <section className="globe-screen" aria-busy="true" data-surface="dark" />;

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
  const light = (projectId: string | null) => () => {
    setLit(projectId);
  };

  return (
    <section
      className="globe-screen"
      aria-label={t('globe.nav')}
      data-testid="globe-screen"
      data-surface="dark"
      data-look={look}
    >
      <GlobeView
        baseUrl={CESIUM_BASE}
        tier={tier}
        style={look}
        street={street}
        palette={GLOBE_PALETTE}
        onlineSatellite={online}
        sites={loaded.sites}
        imagery={imagery}
        terrain={terrain}
        exaggeration={prefs.terrainExaggeration ?? 1}
        issuePins={pins}
        tilesets={tilesets && tilesets.projectId === project?.id ? tilesets : null}
        start={start}
        reducedMotion={reducedMotion}
        onPick={setPick}
        selected={site?.projectId ?? null}
        highlighted={lit}
        describe={describe}
        onCredits={setCredits}
        measuring={measuring}
        onMeasure={setMeasured}
        onReady={setCtl}
        onClose={(c) => {
          lastCamera = c;
        }}
      />
      <aside className="globe-panel" aria-label={t('globe.sites')}>
        <header className="globe-head">
          <h1 className="globe-title">{t('globe.nav')}</h1>
          {loaded.sites.length > 0 && (
            <span className="globe-count">
              {t('globe.siteCount', { count: loaded.sites.length })}
            </span>
          )}
        </header>
        {loaded.error && <p className="globe-error">{loaded.error}</p>}
        {loaded.sites.length === 0 ? (
          <p className="globe-empty">{t('globe.noSites', { product: brand.productName })}</p>
        ) : (
          <ul className="globe-sites" data-testid="globe-sites">
            {loaded.sites.map((s) => (
              <li key={s.projectId}>
                <button
                  type="button"
                  className="globe-site"
                  data-tone={s.issues.open > 0 ? 'attention' : 'clear'}
                  aria-current={pick?.projectId === s.projectId ? 'true' : undefined}
                  onMouseEnter={light(s.projectId)}
                  onMouseLeave={light(null)}
                  onFocus={light(s.projectId)}
                  onBlur={light(null)}
                  onClick={() => {
                    setPick({ kind: 'site', projectId: s.projectId });
                    void ctl?.flyToSite(s.lonLat);
                  }}
                >
                  <span className="globe-dot" aria-hidden="true" />
                  <span className="name">{s.name}</span>
                  <SiteFacts site={s} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="globe-options">
          <div className="globe-field">
            <span id="globe-look-label">{t('globe.look')}</span>
            <div className="seg globe-looks" role="group" aria-labelledby="globe-look-label">
              {GLOBE_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  aria-pressed={look === style}
                  data-testid={`globe-look-${style}`}
                  onClick={() => {
                    save({ ...prefs, style });
                  }}
                >
                  {t(LOOK_LABEL[style])}
                </button>
              ))}
            </div>
          </div>
          {look === 'street' && loaded.street.length === 0 && (
            <p className="globe-note">{t('globe.noStreetPacks')}</p>
          )}
          {look === 'satellite' && loaded.imagery.length === 0 && !online && (
            <p className="globe-note">{t('globe.satelliteHint')}</p>
          )}
          {look !== 'street' && (
            <label className="globe-field">
              <span>{t('globe.imagery')}</span>
              <select
                className="input"
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
          )}
          <label className="globe-field">
            <span>{t('globe.terrain')}</span>
            <select
              className="input"
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
          <button
            type="button"
            className="btn globe-measure"
            aria-pressed={measuring}
            onClick={() => {
              setMeasuring(!measuring);
              setPick(null);
            }}
          >
            <Icon name="measure" size={14} />
            {t('globe.measure')}
          </button>
        </div>
        <ul className="globe-key" aria-label={t('globe.key')}>
          <li data-tone="clear">
            <span className="globe-dot" aria-hidden="true" />
            {t('globe.keyClear')}
          </li>
          <li data-tone="attention">
            <span className="globe-dot" aria-hidden="true" />
            {t('globe.keyAttention')}
          </li>
        </ul>
      </aside>
      {measuring && (
        <p className="globe-readout" data-testid="globe-readout" aria-live="polite">
          {measured.length < 2 ? (
            t('globe.measureHint')
          ) : (
            <>
              <span>{t('globe.distance', { value: formatLength(pathLength(measured)) })}</span>
              {measured.length >= 3 && (
                <span>{t('globe.area', { value: formatArea(polygonArea(measured)) })}</span>
              )}
            </>
          )}
        </p>
      )}
      {site && (
        <div className="globe-card" role="dialog" aria-label={site.name} data-testid="globe-card">
          <button
            type="button"
            className="btn ghost icon sm globe-card-close"
            aria-label={t('globe.closeCard')}
            onClick={() => {
              setPick(null);
            }}
          >
            <Icon name="x" size={14} />
          </button>
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
                  className="btn primary"
                  disabled={busy !== null}
                  onClick={() => void openSite(site.projectId, issue.id)}
                >
                  {t('globe.openIssue')}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 data-tone={site.issues.open > 0 ? 'attention' : 'clear'}>
                <span className="globe-dot" aria-hidden="true" />
                {site.name}
              </h2>
              <SiteFacts site={site} tilesets />
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void ctl?.flyToSite(site.lonLat)}
                >
                  {t('globe.flyTo')}
                </button>
                <button
                  type="button"
                  className="btn primary"
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
      <div className="globe-controls" role="group" aria-label={t('globe.controls')}>
        <button
          type="button"
          className="btn ghost icon"
          aria-label={t('globe.zoomIn')}
          title={t('globe.zoomIn')}
          onClick={() => ctl?.zoom('in')}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          aria-label={t('globe.zoomOut')}
          title={t('globe.zoomOut')}
          onClick={() => ctl?.zoom('out')}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          aria-label={t('globe.allSites')}
          title={t('globe.allSites')}
          data-testid="globe-all-sites"
          onClick={() => {
            setPick(null);
            ctl?.flyHome(sitesBounds(loaded.sites));
          }}
        >
          <Icon name="globe" />
        </button>
      </div>
      <footer className="globe-credits" data-testid="globe-credits" aria-label={t('globe.credits')}>
        {credits.map((c) => (
          <span key={c}>{c}</span>
        ))}
        <span>CesiumJS (Apache-2.0)</span>
      </footer>
    </section>
  );
}
