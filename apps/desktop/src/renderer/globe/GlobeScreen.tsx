import { brand } from '@aio/brand';
import { reducedMotion } from '@aio/engine';
import {
  formatArea,
  formatLength,
  globeToSite,
  issuePins,
  lastCapture,
  pathLength,
  planCredits,
  planGlobeLayers,
  polygonArea,
  rasterOrder,
  selectPacks,
  sitesBounds,
  sortSites,
  type GlobeCamera,
  type Insets,
  type SiteGeoref,
} from '@aio/globe';
import {
  GlobeView,
  type GlobeController,
  type GlobeHover,
  type GlobePick,
  type GlobeTagText,
  type SiteOutputs as SiteOutputsInput,
} from '@aio/globe/view';
import {
  defaultGlobeSettings,
  type GlobeSettings,
  type GlobeSite,
  type MapPackInfo,
  type ProjectManifest,
  type RasterPackInfo,
  type TilesetEntry,
} from '@aio/schema';
import { Icon, t, useT } from '@aio/ui';
import { dateShiftOf, useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGraphics } from '../graphics';
import { drawnBase } from '../maps/mapMenuModel';
import { bridge, shell, useShell } from '../shell';
import { BrandLoader } from '../shell/BrandMotion';
import { rasterPacks, useRasterPacks } from '../workspace/siteTiles';
import './globe.css';
import { GlobeMenu } from './GlobeMenu';
import { globeBaseOf, globeDraw, globePacksOf } from './globeBase';
import { GlobeSearch, type GlobeSearchHandle } from './GlobeSearch';
import { onGlobeRequest, takeGlobeRequest } from './request';
import { SiteFacts } from './SiteFacts';
import { SiteOutputs } from './SiteOutputs';
import {
  clearPyramids,
  focusSites,
  loadPyramid,
  outputRasters,
  shownOf,
  useSiteOutputs,
} from './siteOutputsStore';
import { GLOBE_PALETTE, useStreetTiles } from './street';
import { PageHeader } from '../shell/PageHeader';

/** Where the renderer build serves its copy of Cesium (electron.vite.config.ts `cesiumAssets`). */
const CESIUM_BASE = new URL('cesium/', document.baseURI).href;

/**
 * The room the screen's own pieces take at each edge: the card of a pin keeps clear of the top
 * row, the view buttons at the right and the credits, and so do the chips of the sites a flight
 * frames (**Show all sites**, a click on a gathered chip).
 */
const CARD_INSETS: Insets = { top: 56, right: 56, bottom: 44, left: 12 };

/**
 * No imagery packs (the packs switched off): one array for every render, since the Globe
 * rebuilds its layers and terrain whenever it is handed a new one.
 */
const NO_PACKS: RasterPackInfo[] = [];

/** The words on the chip of sites that gathered. */
const clusterLabel = (count: number) => t('globe.siteCount', { count });

/** The Globe camera when it last closed, and the project open then (this session). */
let lastCamera: { projectId: string | null; camera: GlobeCamera } | null = null;
/** The project "Open site here" just opened: the camera left then belongs to it. */
let handedTo: string | null = null;

/**
 * Where the Globe starts: the camera it was left at when the same project is still open (or none
 * is), else the whole Earth centred over the open project's site, else the camera it was left
 * at, else the whole Earth over the middle of the sites (the Globe's own default).
 */
function startOf(
  projectId: string | null,
  sites: readonly GlobeSite[],
): { camera: GlobeCamera } | { centre: GlobeSite['lonLat'] } | null {
  const last = lastCamera;
  if (last?.projectId === projectId) return { camera: last.camera };
  const own = projectId === null ? undefined : sites.find((s) => s.projectId === projectId);
  if (own) return { centre: own.lonLat };
  return last ? { camera: last.camera } : null;
}

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

/** The Globe screen (M10 G6): loaded lazily, so CesiumJS costs nothing until it opens. */
export default function GlobeScreen() {
  useT();
  const tier = useGraphics((s) => s.tier);
  const library = useShell((s) => s.library);
  const project = useWorkspace((s) => s.project);
  // the hand-over is spent once the Globe is back
  useEffect(() => {
    handedTo = null;
  }, []);
  const issues = useWorkspace((s) => s.issues);
  const loaded = useGlobeData();
  const [settings, setSettings] = useState<GlobeSettings | null>(null);
  const [pick, setPick] = useState<GlobePick | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [ctl, setCtl] = useState<GlobeController | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measured, setMeasured] = useState<[number, number][]>([]);
  const search = useRef<GlobeSearchHandle>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const prefs = settings ?? loaded?.settings ?? defaultGlobeSettings();

  const imagery = useMemo(
    () => selectPacks(loaded?.imagery ?? [], prefs.imagery),
    [loaded, prefs.imagery],
  );
  const terrain = useMemo(
    () => selectPacks(loaded?.terrain ?? [], prefs.terrain ?? 'auto'),
    [loaded, prefs.terrain],
  );
  // the base map (the Map menu, or 0.11's look), the packs switch, and what can be drawn now:
  // main holds the online maps switch and serves or refuses every tile
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const onlineOn = useRasterPacks((s) => s.prefs.onlineSatellite);
  const onlineState = useRasterPacks((s) => s.online);
  const base = globeBaseOf(prefs, { enabled: onlineOn, source: onlineState.source });
  const packsOn = globePacksOf(prefs);
  const drawn = drawnBase(base, { enabled: onlineOn, offlineOnly }, onlineState.keys);
  const { style: look, online } = globeDraw(drawn.base, packsOn);
  const street = useStreetTiles(loaded?.street ?? null, look, tier);
  useEffect(() => {
    rasterPacks.getState().refresh();
  }, []);
  // the sites in focus: the open project, and the site picked when it is another one
  const focusKey = focusSites(project?.id ?? null, pick?.projectId ?? null).join('\n');
  const focus = useMemo(() => (focusKey ? focusKey.split('\n') : []), [focusKey]);
  // each one's 3D Tiles (G7's `tilesets:list`): none drawn until it answers, none when it fails
  const [tilesets, setTilesets] = useState<Record<string, TilesetEntry[]>>({});
  useEffect(() => {
    let live = true;
    for (const projectId of focus)
      void bridge.call('tilesets:list', { projectId }).then((r) => {
        if (!live) return;
        const entries = r.ok && r.value.ok ? r.value.file.entries : [];
        setTilesets((now) => ({ ...now, [projectId]: entries }));
      });
    return () => {
      live = false;
    };
    // the open project read again when it changes (a tiles job wrote a tileset)
  }, [focus, project]);
  const shown = useSiteOutputs((s) => s.shown);
  const indexes = useSiteOutputs((s) => s.indexes);
  // the indexes of the rasters shown (the card reads the others); forgotten when the Globe closes
  const focusSitesData = useMemo(
    () =>
      focus.flatMap((id) => {
        const s = loaded?.sites.find((x) => x.projectId === id);
        return s ? [s] : [];
      }),
    [focus, loaded],
  );
  useEffect(() => {
    for (const s of focusSitesData) {
      if (!s.frame) continue;
      const on = new Set(shownOf(shown, s));
      for (const r of s.rasters ?? []) if (on.has(r.layerId)) void loadPyramid(s.projectId, r.src);
    }
  }, [focusSitesData, shown]);
  useEffect(() => clearPyramids, []);
  const outputs = useMemo(
    () =>
      focus.flatMap((projectId): SiteOutputsInput[] => {
        const entries = tilesets[projectId];
        if (!entries) return [];
        const s = loaded?.sites.find((x) => x.projectId === projectId);
        const open = project?.id === projectId ? project : null;
        // the open project is placed by its manifest; another site by its frame, or not at all
        const georef = open
          ? georefOf(open.manifest)
          : s?.frame
            ? { ...s.frame, heightOffset: 0 }
            : null;
        if (!georef) return [];
        const on = s?.frame ? new Set(shownOf(shown, s)) : new Set<string>();
        const rasters = s
          ? outputRasters(
              projectId,
              rasterOrder(
                (s.rasters ?? []).filter((r) => on.has(r.layerId)),
                s.captures,
              ),
              indexes,
              open?.manifest ?? null,
            )
          : [];
        return [{ projectId, georef, tilesets: entries, rasters }];
      }),
    [focus, tilesets, loaded, project, shown, indexes],
  );
  const pins = useMemo(() => {
    if (!project || prefs.showIssues === false) return null;
    return {
      projectId: project.id,
      georef: georefOf(project.manifest),
      pins: issuePins(issues, project.manifest, (layerId) =>
        dateShiftOf(project.manifest, layerId),
      ),
    };
  }, [project, issues, prefs.showIssues]);
  // an issue's card goes when its pin does: issues hidden, another project opened, the issue closed
  // (dropped while rendering, so the card is never drawn without its pin)
  if (
    pick?.kind === 'issue' &&
    !(pins?.projectId === pick.projectId && pins.pins.some((p) => p.id === pick.issueId))
  )
    setPick(null);
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

  /** The words of the label under the pointer: a site's name and state, or an issue. */
  const describe = useCallback(
    (what: GlobeHover): GlobeTagText | null => {
      // a cluster's chip already says how many sites it holds
      if (what.kind === 'cluster') return null;
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
    // opening the project may close the Globe: the camera it leaves belongs to that project
    handedTo = projectId;
    if (workspace.getState().project?.id !== projectId)
      await shell.getState().openProject(entry.path);
    setBusy(null);
    const opened = workspace.getState().project;
    if (!opened) {
      handedTo = null;
      return;
    }
    if (camera && !issueId)
      shell.getState().saveView(opened.id, globeToSite(camera, georefOf(opened.manifest)));
    if (issueId) workspace.getState().select({ kind: 'issue', id: issueId });
    shell.getState().go('scene');
  };

  /**
   * Close the card from inside it (Esc, its Close button). With the keyboard in the card (Esc
   * there, Enter or Space on Close), the card goes from under it: the keyboard is put back in the
   * field the site was picked from, its list left shut, not left on nothing. A click of the
   * mouse on Close finds the focus elsewhere (the button does not take it) and leaves it there:
   * no text field shows its ring for a click.
   */
  const closeCard = () => {
    const inCard = cardEl.current?.contains(document.activeElement) === true;
    setPick(null);
    if (inCard) search.current?.focus();
  };

  if (!loaded)
    return (
      <>
        <PageHeader heading="globe.nav" />
        <section className="globe-screen" aria-busy="true" data-surface="dark">
          <BrandLoader className="globe-loader" />
        </section>
      </>
    );

  const site = pick ? loaded.sites.find((s) => s.projectId === pick.projectId) : undefined;
  const issue =
    pick?.kind === 'issue' && project?.id === pick.projectId
      ? issues.find((i) => i.id === pick.issueId)
      : undefined;
  const start = startOf(project?.id ?? null, loaded.sites);
  // the library could not be read, or nothing in it can be placed
  const notice =
    loaded.error ??
    (loaded.sites.length === 0 ? t('globe.noSites', { product: brand.productName }) : null);

  // the Globe keeps this by the pin it tells of (a site's, or an issue's)
  const card = site && (
    <div
      ref={cardEl}
      className="globe-card"
      role="dialog"
      aria-label={site.name}
      data-testid="globe-card"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        closeCard();
      }}
    >
      <button
        type="button"
        className="btn ghost icon sm globe-card-close"
        aria-label={t('globe.closeCard')}
        // A press of the mouse does not move the focus to this button. It goes with the card,
        // and the focus it took would be handed to the nearest control left, the field
        // (`keepFocusAlive`), whose list opens when the focus comes into it.
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={closeCard}
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
          <SiteOutputs site={site} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => void ctl?.flyToSite(site.lonLat)}>
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
  );

  const page = (
    <section
      className="globe-screen"
      aria-label={t('globe.nav')}
      data-testid="globe-screen"
      data-surface="dark"
      data-look={look}
    >
      {/* the screen's heading, for a screen reader: nothing on the Globe shows its name */}
      <h1 className="sr-only">{t('globe.nav')}</h1>
      {/* the top edge, in tab order: the field (the read-out while measuring), then Map */}
      {measuring ? (
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
      ) : (
        loaded.sites.length > 0 && (
          <GlobeSearch
            handle={search}
            sites={loaded.sites}
            selected={site?.projectId ?? null}
            onPick={(s) => {
              setPick({ kind: 'site', projectId: s.projectId });
              void ctl?.flyToSite(s.lonLat);
            }}
            onLight={setLit}
            // after a pick with the keyboard the focus is in the field, not in the card: Esc
            // there, once the list is shut, closes the card too
            onEscape={
              site
                ? () => {
                    setPick(null);
                  }
                : undefined
            }
          />
        )
      )}
      {notice && (
        <p
          className="globe-notice"
          role="status"
          data-testid="globe-notice"
          data-tone={loaded.error ? 'danger' : undefined}
        >
          {notice}
        </p>
      )}
      <GlobeMenu
        prefs={prefs}
        base={base}
        packsOn={packsOn}
        tier={tier}
        imagery={loaded.imagery}
        terrain={loaded.terrain}
        streetPacks={loaded.street.length}
        streetCredit={street?.credit ?? '© OpenStreetMap contributors'}
        onSave={save}
      />
      <GlobeView
        baseUrl={CESIUM_BASE}
        tier={tier}
        style={look}
        street={street}
        palette={GLOBE_PALETTE}
        online={online}
        sites={loaded.sites}
        imagery={packsOn ? imagery : NO_PACKS}
        terrain={terrain}
        exaggeration={prefs.terrainExaggeration ?? 1}
        issuePins={pins}
        outputs={outputs}
        start={start}
        reducedMotion={reducedMotion}
        onPick={setPick}
        // sites that share a chip at any zoom are told apart by name, in the field's list
        onGroup={(projectIds) => search.current?.list(projectIds)}
        selected={site?.projectId ?? null}
        highlighted={lit}
        describe={describe}
        card={card}
        cardPick={pick}
        cardInsets={CARD_INSETS}
        clusterLabel={clusterLabel}
        onCredits={setCredits}
        measuring={measuring}
        onMeasure={setMeasured}
        onReady={setCtl}
        onClose={(c) => {
          lastCamera = { projectId: handedTo ?? project?.id ?? null, camera: c };
        }}
      />
      <div className="globe-controls" role="group" aria-label={t('globe.controls')}>
        <button
          type="button"
          className="btn ghost icon globe-measure"
          aria-label={t('globe.measure')}
          title={t('globe.measure')}
          aria-pressed={measuring}
          data-testid="globe-measure"
          onClick={() => {
            setMeasuring(!measuring);
            setPick(null);
          }}
        >
          <Icon name="measure" />
        </button>
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
  return (
    <>
      <PageHeader heading="globe.nav" />
      {page}
    </>
  );
}
