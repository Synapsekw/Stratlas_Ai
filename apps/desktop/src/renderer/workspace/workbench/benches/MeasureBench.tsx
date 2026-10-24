/**
 * The Measure workbench, the body of the Project tab (stage island D12, D13, D16, D18, D19): the
 * "In this project" list (`project/ProjectList.tsx`) over a TOOLS caption, then the tools as they
 * always were: the save controls, search, Favourites and recent, every measuring tool by family,
 * Site data, Drawing aids and Templates.
 * While a tool is live it morphs in place: the live card on top (the shared measurement card in
 * its live variant, then the points, Undo, Stop and Save with their keys) and the catalogue
 * shrinks to a strip of tool buttons. A picked measurement shows its detail card inline in the list.
 * How the sidebar follows the tools is `workbench/measureFollow.ts`.
 */
import type { EngineStage } from '@aio/engine';
import { formatQuantity, localeOf, unitLabel } from '@aio/geo';
import { DEFAULT_ANGLES, type SitePoint } from '@aio/schema';
import {
  bookmarks,
  formatBearingAs,
  industryTemplates,
  isTelecomTool,
  measurementFrom,
  MIN_POINTS,
  parseBearing,
  templateLibrary,
  TOOL_FAMILY,
  TOOL_LABELS,
  type SnapSource,
} from '@aio/survey';
import {
  ariaKeys,
  Button,
  EmptyState,
  IconButton,
  Row,
  shortcutHint,
  useT,
  type IconName,
  type MessageKey,
} from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShell } from '../../../shell';
import { cardModel, MeasureCard, TOOL_ICON } from '../../../survey/card';
import { useCardTerrain } from '../../../survey/card/slots';
import { openCompareDialog } from '../../../survey/compareStore';
import { DesignsTool } from '../../../survey/Designs';
import { ExportTool } from '../../../survey/ExportDialog';
import { HaulRoadTool } from '../../../survey/HaulRoad';
import { HydroTool } from '../../../survey/Hydro';
import { MagicPolygon } from '../../../survey/MagicPolygon';
import { PendingNote, usePending } from '../../../survey/PendingNote';
import {
  entryOf,
  familiesFor,
  favouritesAndRecent,
  matchesQuery,
  measureFavourites,
  useFavourites,
  type CatalogueEntry,
  type CatalogueTool,
  type Family,
} from '../../../survey/measureCatalogue';
import {
  drawEvent,
  measureStore,
  openDialog,
  setSnap,
  setSnapSource,
  startTool,
  stopTool,
  useMeasure,
} from '../../../survey/measureStore';
import { setOverlaysOpen, useOverlays } from '../../../survey/overlaysStore';
import { SurveyQaTool } from '../../../survey/Qa';
import { SavedFooter } from '../../../survey/SavedFooter';
import {
  startTelecomTool,
  TelecomTools,
  useTelecomUnavailable,
} from '../../../survey/TelecomTools';
import { AntennaCsvTool } from '../../../telecom/AntennaCsvTool';
import { Tool, useEngineStage } from '../../StageTools';
import { SectionPanel, toggleMeasure, toggleSection } from '../../tools/measure';
import { ProjectList } from '../project/ProjectList';
import { Section } from '../Section';
import { filterSections, sectionStore } from '../sectionState';
import type { TabId } from '../tabsModel';
import './measureBench.css';

const BENCH: TabId = 'measure';

// ---------------------------------------------------------------- tools

/** A read-only project or a package: only the tools that read without saving (D6). */
function useReadOnly(): boolean {
  const pkg = useShell((s) => s.pkg !== null);
  return useMeasure((s) => s.readOnly) || pkg;
}

/** The test id of a tool's button (the survey ids the e2e specs know). */
function testIdOf(tool: CatalogueTool): string {
  if (tool === 'section-plane') return 'measure-tool-section-plane';
  return isTelecomTool(tool) ? `telecom-tool-${tool}` : `survey-tool-${tool}`;
}

/** Start a catalogue tool, or put it away when it is the live one. */
function startEntry(tool: CatalogueTool, stage: EngineStage | null): void {
  if (tool === 'section-plane') {
    // not a survey tool: the other starts count in recent through followRecent
    measureFavourites.getState().used(tool);
    if (stage) toggleSection(stage);
    return;
  }
  const active = measureStore.getState().tool;
  if (active?.tool === tool && !active.template) {
    stopTool();
    return;
  }
  if (tool === 'distance') toggleMeasure(stage);
  else if (isTelecomTool(tool)) startTelecomTool(tool);
  else {
    if (stage && stage.tool !== 'select') stage.setTool('select');
    startTool(tool);
  }
}

/** Whether a tool is on, and why it cannot start (telecom picks need the 3D view). */
function useToolState(stage: EngineStage | null) {
  const active = useMeasure((s) => s.tool);
  const telecomOff = useTelecomUnavailable();
  return {
    on: (tool: CatalogueTool) =>
      tool === 'section-plane'
        ? stage?.section.enabled === true
        : active?.tool === tool && !active.template,
    disabled: (tool: CatalogueTool) =>
      (tool === 'section-plane' && !stage) ||
      (tool !== 'section-plane' && isTelecomTool(tool) && telecomOff !== null),
  };
}

/**
 * The rows' icons: the card's one glyph per tool (`TOOL_ICON`), so the tree, the bench and the
 * card agree; the section plane is the bench's own (not a measurement).
 */
const BENCH_ICON: Record<'section-plane', IconName> = { 'section-plane': 'section' };
const iconOf = (tool: CatalogueTool): IconName =>
  tool === 'section-plane' ? BENCH_ICON[tool] : TOOL_ICON[tool];

function ToolRow({
  entry,
  testId,
  stage,
}: {
  entry: CatalogueEntry;
  testId: string;
  stage: EngineStage | null;
}) {
  const t = useT();
  const state = useToolState(stage);
  const starred = useFavourites((s) => s.favourites.includes(entry.tool));
  const on = state.on(entry.tool);
  return (
    <Row
      kind="tree"
      as="li"
      className="meb-row"
      selected={on}
      icon={iconOf(entry.tool)}
      label={
        <button
          type="button"
          className="meb-tool"
          data-testid={testId}
          aria-pressed={on}
          aria-keyshortcuts={entry.key ? ariaKeys(entry.key) : undefined}
          disabled={state.disabled(entry.tool)}
          onClick={() => {
            startEntry(entry.tool, stage);
          }}
        >
          <span className="meb-name">{entry.label}</span>
          <span className="meb-hint">{entry.hint}</span>
        </button>
      }
      {...(entry.key ? { count: shortcutHint(entry.key) } : {})}
      actions={
        <IconButton
          icon="flag"
          label={t(starred ? 'measureBench.unstar' : 'measureBench.star', { tool: entry.label })}
          pressed={starred}
          onClick={() => {
            measureFavourites.getState().toggle(entry.tool);
          }}
        />
      }
    />
  );
}

function ToolList({
  entries,
  stage,
  fav,
}: {
  entries: readonly CatalogueEntry[];
  stage: EngineStage | null;
  fav?: boolean;
}) {
  return (
    <ul className="meb-list">
      {entries.map((e) => (
        <ToolRow
          key={e.tool}
          entry={e}
          stage={stage}
          testId={fav ? `measure-fav-${e.tool}` : testIdOf(e.tool)}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- the live morph

/**
 * The unsaved state on top of the bench while no tool draws (D18: in the workbench, not over the
 * stage); nothing at all when there is nothing to say, a read-only project included.
 */
function PendingCard() {
  if (!usePending()) return null;
  return (
    <div className="meb-live">
      <PendingNote />
    </div>
  );
}

/** How long the pointer rests before the live card reads the terrain under the drawing. */
const LIVE_TERRAIN_DELAY_MS = 250;

/** The live tool on top of the bench: its reading, its points and Undo, Stop and Save (D13). */
function LiveCard() {
  const t = useT();
  const tool = useMeasure((s) => s.tool);
  const draw = useMeasure((s) => s.draw);
  const settings = useMeasure((s) => s.settings);
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  const units = settings.units;
  const locale = settings.locale ?? localeOf(units.distance);
  const angles = settings.angles ?? DEFAULT_ANGLES;
  // the measurement as it would be saved now (the cursor as its next point), on the shared card
  const live = useMemo(() => {
    // a telecom tool's card is TelecomTools' own: nothing to build here on each cursor move
    if (!tool || !draw || isTelecomTool(tool.tool)) return null;
    const pts = draw.cursor && !draw.done ? [...draw.points, draw.cursor] : draw.points;
    return measurementFrom(tool.template ?? tool.tool, {
      id: 'live',
      label: tool.template?.name ?? TOOL_LABELS[tool.tool],
      scope: { kind: 'site' },
      points: pts,
      createdAt: '',
    });
  }, [tool, draw]);
  // the terrain under it only when the card shows a terrain row (a pile's never does), read as
  // the panel reads it, once the pointer rests: never on each cursor move
  const { surface, terrainPending, terrainError } = useCardTerrain(
    live && live.points.length >= MIN_POINTS[live.family] ? live : null,
    tool?.template?.items,
    { delayMs: LIVE_TERRAIN_DELAY_MS },
  );
  const model = useMemo(() => {
    if (!live) return null;
    const card = cardModel(live, {
      settings,
      templates: tool?.template ? [tool.template] : [],
      captures: captures ?? [],
      ...(surface ? { surface } : {}),
      ...(terrainPending ? { terrainPending } : {}),
      ...(terrainError ? { terrainError } : {}),
    });
    return live.points.length < MIN_POINTS[live.family]
      ? { ...card, primary: null, secondary: '' }
      : card;
  }, [live, tool, settings, surface, terrainPending, terrainError, captures]);
  if (!tool || !draw) return null;
  // the telecom tools keep their own card: what to pick, the picks so far and the reading
  if (isTelecomTool(tool.tool)) {
    return (
      <div className="meb-live">
        <TelecomTools />
      </div>
    );
  }
  if (!model) return null;
  const family = TOOL_FAMILY[tool.tool];
  const bearing = parseBearing(draw.typing.bearing);
  const env = { distanceUnit: units.distance };
  const n = draw.points.length;
  const points: SitePoint[] = draw.points.slice(-4);
  const enough = n >= MIN_POINTS[family];
  const coord = (v: number) => formatQuantity(v, 'coordinate', units, settings.precision, locale);
  return (
    <section
      className="meb-live"
      aria-label={t('measureBench.live', { tool: tool.template?.name ?? TOOL_LABELS[tool.tool] })}
      data-testid="survey-drawbar"
    >
      <MeasureCard model={model} variant="live" testId="measure-live-card" />
      {tool.transient && <span className="meb-faint">{t('measureBench.notSaved')}</span>}
      {tool.prompt && (
        <span className="meb-faint" role="status" data-testid="survey-draw-prompt">
          {tool.prompt}
        </span>
      )}
      {!model.primary && (
        <p className="meb-faint" data-testid="measure-reading">
          {t('measureBench.noReading')}
        </p>
      )}
      <p className="meb-faint">
        {t('measureBench.points', { count: n })}
        {draw.lockedBearing !== null &&
          t('measureBench.locked', {
            deg: formatBearingAs(draw.lockedBearing, angles, locale),
          })}
        {draw.snap && t('measureBench.snapped', { source: draw.snap.source, kind: draw.snap.kind })}
      </p>
      {points.length > 0 && (
        <ol className="meb-points mono" start={n - points.length + 1}>
          {points.map((p, i) => (
            <li key={n - points.length + i}>
              E {coord(p[0])} N {coord(p[1])} Z {coord(p[2])}
            </li>
          ))}
        </ol>
      )}
      {family !== 'point' && (
        <div className="meb-typed">
          <span
            className={`sv-typed${draw.typing.field === 'distance' ? ' on' : ''}`}
            data-testid="survey-typed-distance"
          >
            {t('measureBench.typedDistance')}{' '}
            <b className="mono">{draw.typing.distance || '...'}</b> {unitLabel(units.distance)}
          </span>
          <span
            className={`sv-typed${draw.typing.field === 'bearing' ? ' on' : ''}`}
            data-testid="survey-typed-bearing"
          >
            {t('measureBench.typedBearing')} <b className="mono">{draw.typing.bearing || '...'}</b>
            {/* what was typed, read back in the site's bearing style */}
            {bearing !== null && (
              <span className="meb-faint mono" data-testid="survey-typed-bearing-value">
                {' '}
                {formatBearingAs(bearing, angles, locale)}
              </span>
            )}
          </span>
        </div>
      )}
      {family === 'polygon' && <MagicPolygon />}
      <div className="meb-live-acts">
        <Button
          shortcut="scene.drawUndo"
          disabled={n === 0}
          onClick={() => {
            drawEvent({ type: 'undo' }, env);
          }}
        >
          {t('measureBench.undo')} <span className="kbd">{shortcutHint('scene.drawUndo')}</span>
        </Button>
        <Button
          variant="quiet"
          shortcut="scene.escape"
          onClick={() => {
            stopTool();
          }}
        >
          {t('measureBench.stop')} <span className="kbd">{shortcutHint('scene.escape')}</span>
        </Button>
        {!tool.transient && family !== 'point' && (
          <Button
            variant="primary"
            shortcut="scene.drawFinish"
            disabled={!enough}
            data-testid="survey-finish"
            onClick={() => {
              drawEvent({ type: 'finish' }, env);
            }}
          >
            {t('measureBench.save')} <span className="kbd">{shortcutHint('scene.drawFinish')}</span>
          </Button>
        )}
      </div>
      <PendingNote />
    </section>
  );
}

/** While a tool is live: every tool as a short text button, to switch without leaving (D13). */
function Strip({ families, stage }: { families: readonly Family[]; stage: EngineStage | null }) {
  const t = useT();
  const state = useToolState(stage);
  const ref = useRef<HTMLDivElement>(null);
  // started from a catalogue row that the morph took away: focus the live tool's button
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null)
      ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }, []);
  return (
    <div ref={ref} className="meb-strip" role="group" aria-label={t('measureBench.strip')}>
      {families.flatMap((f) =>
        f.tools.map((e) => (
          <Button
            key={e.tool}
            variant="quiet"
            size="sm"
            pressed={state.on(e.tool)}
            disabled={state.disabled(e.tool)}
            data-testid={testIdOf(e.tool)}
            onClick={() => {
              startEntry(e.tool, stage);
            }}
          >
            {e.label}
          </Button>
        )),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the catalogue

const SNAP_SOURCES: { source: SnapSource; label: MessageKey }[] = [
  { source: 'measurement', label: 'measureBench.snapMeasurements' },
  { source: 'design', label: 'measureBench.snapDesigns' },
  { source: 'alignment', label: 'measureBench.snapAlignments' },
  { source: 'guide', label: 'measureBench.snapGuidelines' },
];

/** A label matches the search (case-insensitive, anywhere in it). */
const labelMatches = (label: string, query: string): boolean =>
  label.toLowerCase().includes(query.trim().toLowerCase());

type SiteItem =
  'designs' | 'qa' | 'overlays' | 'hydro' | 'haul' | 'export' | 'materials' | 'site' | 'units';

/** Site data's entries by the names their buttons carry, for the search (D16). */
const SITE_ITEMS: readonly { id: SiteItem; label: MessageKey }[] = [
  { id: 'designs', label: 'measureBench.siteDesigns' },
  { id: 'qa', label: 'measureBench.siteQa' },
  { id: 'overlays', label: 'measureBench.siteOverlays' },
  { id: 'hydro', label: 'measureBench.siteHydro' },
  { id: 'haul', label: 'measureBench.siteHaul' },
  { id: 'export', label: 'measureBench.siteExport' },
  { id: 'materials', label: 'measureBench.siteMaterials' },
  { id: 'site', label: 'measureBench.siteCutFill' },
  { id: 'units', label: 'measureBench.siteUnits' },
];

/** Drawing aids' controls by name, for the search: a match shows the whole section. */
const AID_LABELS: readonly MessageKey[] = [
  'measureBench.snapVertices',
  'measureBench.snapEdges',
  'measureBench.snapTo',
  'measureBench.snapDistance',
  ...SNAP_SOURCES.map((s) => s.label),
];

/** The drawing keys' note: its {shift}, {enter}, {tab} and {esc} drawn as key caps. */
const AID_KEYS: Readonly<Record<string, string>> = {
  shift: 'Shift',
  enter: 'Enter',
  tab: 'Tab',
  esc: 'Esc',
};
function KeysNote({ text }: { text: string }) {
  return (
    <p className="pop-note">
      {text.split(/(\{\w+\})/).map((part, i) => {
        const cap = part.startsWith('{') ? AID_KEYS[part.slice(1, -1)] : undefined;
        return cap ? (
          <span key={i} className="kbd">
            {cap}
          </span>
        ) : (
          part
        );
      })}
    </p>
  );
}

/** The site data entries offered: Units needs a writable project, export a project (not a package). */
function useSiteItems(): SiteItem[] {
  const readOnly = useReadOnly();
  const pkg = useShell((s) => s.pkg !== null);
  return SITE_ITEMS.map((i) => i.id).filter(
    (id) => !(id === 'units' && readOnly) && !(id === 'export' && pkg),
  );
}

/** The site's designs, survey QA, terrain overlays, hydrology, haul road, export and totals. */
function SiteData({ items }: { items: readonly SiteItem[] }) {
  const t = useT();
  const overlaysOpen = useOverlays((s) => s.open);
  const has = (id: SiteItem) => items.includes(id);
  return (
    <div className="meb-site">
      <div className="tgroup-h sv-nested" role="group" aria-label={t('measureCat.family.siteData')}>
        {has('designs') && <DesignsTool />}
        {has('qa') && <SurveyQaTool />}
        {has('overlays') && (
          <Tool
            icon="raster"
            label={t('measureBench.siteOverlays')}
            testId="survey-overlays-open"
            pressed={overlaysOpen}
            onClick={() => {
              setOverlaysOpen(!overlaysOpen);
            }}
          />
        )}
        {has('hydro') && <HydroTool />}
        {has('haul') && <HaulRoadTool />}
        {has('export') && <ExportTool />}
        {has('export') && <AntennaCsvTool />}
      </div>
      <div className="sv-tool-row">
        {has('materials') && (
          <Button
            data-testid="survey-materials-tool"
            onClick={() => {
              openCompareDialog('materials');
            }}
          >
            {t('measureBench.siteMaterials')}
          </Button>
        )}
        {has('site') && (
          <Button
            data-testid="survey-site-open"
            onClick={() => {
              openCompareDialog('site');
            }}
          >
            {t('measureBench.siteCutFill')}
          </Button>
        )}
        {has('units') && (
          <Button
            data-testid="survey-units-open"
            onClick={() => {
              openDialog({ kind: 'units', target: 'site' });
            }}
          >
            {t('measureBench.siteUnits')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Snapping, its sources and distance, and the typed aids. */
function DrawingAids() {
  const t = useT();
  const snap = useMeasure((s) => s.snap);
  return (
    <div className="pop-form meb-aids">
      <label className="pop-row">
        <span className="pop-grow">{t('measureBench.snapVertices')}</span>
        <input
          type="checkbox"
          checked={snap.vertices}
          onChange={(e) => {
            setSnap({ vertices: e.target.checked });
          }}
        />
      </label>
      <label className="pop-row">
        <span className="pop-grow">{t('measureBench.snapEdges')}</span>
        <input
          type="checkbox"
          checked={snap.edges}
          onChange={(e) => {
            setSnap({ edges: e.target.checked });
          }}
        />
      </label>
      <div className="sv-chips" role="group" aria-label={t('measureBench.snapTo')}>
        {SNAP_SOURCES.map((s) => (
          <label key={s.source} className="sv-chip">
            <input
              type="checkbox"
              checked={snap.sources[s.source]}
              onChange={(e) => {
                setSnapSource(s.source, e.target.checked);
              }}
            />
            {t(s.label)}
          </label>
        ))}
      </div>
      <label className="pop-row">
        <span>{t('measureBench.snapDistance')}</span>
        <input
          type="range"
          min={2}
          max={30}
          value={snap.tolerancePx}
          onChange={(e) => {
            setSnap({ tolerancePx: Number(e.target.value) });
          }}
        />
        <span className="mono">{snap.tolerancePx} px</span>
      </label>
      <KeysNote text={t('measureBench.aidsKeys')} />
    </div>
  );
}

/** The bookmarked templates (they start their tool from the Templates section). */
function useBookmarks() {
  const templates = useMeasure((s) => s.templates);
  const sets = useMeasure((s) => s.settings.templateSets);
  return useMemo(
    () => bookmarks(templateLibrary(templates.project, templates.user, industryTemplates(sets))),
    [templates, sets],
  );
}

/** The bookmarked templates (each starts its tool; `only` narrows them) and the editor. */
function Templates({ only }: { only?: (name: string) => boolean }) {
  const t = useT();
  const active = useMeasure((s) => s.tool);
  const lib = useBookmarks().filter(({ template: tpl }) => !only || only(tpl.name));
  return (
    <div className="meb-templates">
      {lib.length > 0 && (
        <ul className="meb-list" aria-label={t('measureBench.bookmarked')}>
          {lib.map(({ template: tpl }) => (
            <Row
              key={tpl.id}
              kind="tree"
              as="li"
              className="meb-row"
              selected={active?.template?.id === tpl.id}
              label={
                <button
                  type="button"
                  className="meb-tool"
                  aria-pressed={active?.template?.id === tpl.id}
                  data-testid={`survey-bookmark-${tpl.id}`}
                  onClick={() => {
                    if (active?.template?.id === tpl.id) stopTool();
                    else startTool(tpl.tool, { template: tpl });
                  }}
                >
                  <span className="meb-name">{tpl.name}</span>
                  <span className="meb-hint">{tpl.description ?? TOOL_LABELS[tpl.tool]}</span>
                </button>
              }
            />
          ))}
        </ul>
      )}
      <Button
        icon="flag"
        data-testid="survey-templates-open"
        onClick={() => {
          openDialog({ kind: 'templates', edit: null, scope: 'project' });
        }}
      >
        {t('measureCat.family.templates')}
      </Button>
    </div>
  );
}

/**
 * The search, Favourites and recent, the families, Site data, Drawing aids and Templates. A query
 * reaches every section by its title and its entries (D16): the sections with a match open, the
 * others hide; with no match anywhere, the empty state says so.
 */
function Catalogue({
  families,
  stage,
  query,
  onQuery,
}: {
  families: readonly Family[];
  stage: EngineStage | null;
  query: string;
  onQuery: (q: string) => void;
}) {
  const t = useT();
  const readOnly = useReadOnly();
  const favourites = useFavourites((s) => s.favourites);
  const recent = useFavourites((s) => s.recent);
  const siteItems = useSiteItems();
  const bookmarked = useBookmarks();
  const offered = useMemo(
    () => new Set(families.flatMap((f) => f.tools.map((e) => e.tool))),
    [families],
  );
  const favEntries = favouritesAndRecent({ favourites, recent })
    .filter((tool) => offered.has(tool))
    .map(entryOf)
    .filter((e): e is CatalogueEntry => e !== undefined);
  // a picked telecom measurement shows in its family (the reading, its endpoints, Save)
  const telecomFocus = useMeasure((s) => {
    const m = s.file.measurements.find((x) => x.id === s.focus);
    return m !== undefined && isTelecomTool(m.tool);
  });
  const siteTitle = t('measureCat.family.siteData');
  const aidsTitle = t('measureCat.family.aids');
  const templatesTitle = t('measureCat.family.templates');
  const searching = query.trim() !== '';
  const found = searching
    ? filterSections(
        families.map((f) => ({ id: f.id, items: f.tools })),
        (e) => matchesQuery(e, query),
      )
    : null;
  // a section's title matching shows all of it; otherwise only its matching entries
  const site =
    !searching || labelMatches(siteTitle, query)
      ? siteItems
      : siteItems.filter((id) =>
          labelMatches(
            t(SITE_ITEMS.find((i) => i.id === id)?.label ?? 'measureCat.family.siteData'),
            query,
          ),
        );
  const aids =
    !searching || [aidsTitle, ...AID_LABELS.map((k) => t(k))].some((l) => labelMatches(l, query));
  const templatesWhole = !searching || labelMatches(templatesTitle, query);
  const templateHits = bookmarked.filter(({ template: tpl }) => labelMatches(tpl.name, query));
  const templates = !readOnly && (templatesWhole || templateHits.length > 0);
  const nothing = searching && found?.length === 0 && site.length === 0 && !aids && !templates;
  const label = (id: string) => families.find((f) => f.id === id)?.label ?? id;
  return (
    <div className="meb-cat" data-testid="survey-tools">
      <input
        type="search"
        className="sv-input meb-search"
        aria-label={t('wb.search')}
        placeholder={t('wb.search')}
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
        }}
      />
      {readOnly && (
        <p className="pop-note" data-testid="survey-tools-readonly">
          {t('measureBench.readOnly')}
        </p>
      )}
      {nothing && (
        <EmptyState
          icon="search"
          title={t('measureBench.noMatch')}
          body={t('measureBench.noMatchBody')}
        />
      )}
      {found?.map((s) => (
        <Section
          bench={BENCH}
          key={s.id}
          id={s.id}
          title={label(s.id)}
          count={s.items.length}
          forceOpen
        >
          <ToolList entries={s.items} stage={stage} />
        </Section>
      ))}
      {!found && (
        <>
          <Section
            bench={BENCH}
            id="favourites"
            title={t('wb.favourites')}
            count={favEntries.length}
            defaultOpen
          >
            <ToolList entries={favEntries} stage={stage} fav />
          </Section>
          {families.map((f) => (
            <Section
              bench={BENCH}
              key={f.id}
              id={f.id}
              title={f.label}
              count={f.tools.length}
              forceOpen={f.id === 'telecom' && telecomFocus ? true : undefined}
            >
              <ToolList entries={f.tools} stage={stage} />
              {f.id === 'telecom' && <TelecomTools />}
              {f.id === 'section' && stage && <SectionPanel stage={stage} />}
            </Section>
          ))}
        </>
      )}
      {site.length > 0 && (
        <Section
          bench={BENCH}
          id="siteData"
          title={siteTitle}
          forceOpen={searching ? true : undefined}
        >
          <SiteData items={site} />
        </Section>
      )}
      {aids && (
        <Section bench={BENCH} id="aids" title={aidsTitle} forceOpen={searching ? true : undefined}>
          <DrawingAids />
        </Section>
      )}
      {templates && (
        <Section
          bench={BENCH}
          id="templates"
          title={templatesTitle}
          forceOpen={searching ? true : undefined}
        >
          <Templates
            {...(templatesWhole ? {} : { only: (name: string) => labelMatches(name, query) })}
          />
        </Section>
      )}
    </div>
  );
}

/**
 * The picked telecom measurement's reading, only when its family is not shown (a read-only package
 * offers no telecom tools; a search hides it). Any other measurement's panel is inline in the
 * Measurements group (`project/groups/MeasurementsGroup.tsx`).
 */
function SelectedCard({ searching }: { searching: boolean }) {
  const t = useT();
  const readOnly = useReadOnly();
  const focusTool = useMeasure((s) => s.file.measurements.find((m) => m.id === s.focus)?.tool);
  if (!focusTool) return null;
  if (isTelecomTool(focusTool)) {
    if (!readOnly && !searching) return null;
    return (
      <Section bench={BENCH} id="selected" title={t('measureBench.selected')} defaultOpen>
        <TelecomTools />
      </Section>
    );
  }
  // any other measurement is shown inline in the Measurements group of the list above
  return null;
}

/**
 * Collapse all during a search clears the search: the search holds its sections open, so the
 * button would otherwise flip to Expand all with nothing folded. The sections then fold as asked.
 */
function useCollapseEndsSearch(setQuery: (q: string) => void): void {
  const all = useStore(sectionStore, (s) => s.byBench[BENCH]?.all);
  const seen = useRef(all);
  useEffect(() => {
    if (all === seen.current) return;
    seen.current = all;
    if (all === false) setQuery('');
  }, [all, setQuery]);
}

/** The Measure workbench's body, under the sidebar's bench header. */
export function MeasureBench() {
  const stage = useEngineStage();
  const readOnly = useReadOnly();
  const live = useMeasure((s) => s.tool !== null && s.draw !== null);
  const families = useMemo(() => familiesFor(readOnly), [readOnly]);
  const [query, setQuery] = useState('');
  const searching = !live && query.trim() !== '';
  useCollapseEndsSearch(setQuery);
  return (
    <div className="meb wb-scroll">
      {/* a running tool is never pushed down: its card (or the unsaved state) stays first */}
      {live ? <LiveCard /> : <PendingCard />}
      {/* In this project, then the TOOLS caption; a search filters only the tools */}
      <ProjectList />
      {/* a search is about the tools: the save controls step aside until it is cleared */}
      {!searching && <SavedFooter />}
      {live ? (
        <Strip families={families} stage={stage} />
      ) : (
        <>
          <Catalogue families={families} stage={stage} query={query} onQuery={setQuery} />
          <SelectedCard searching={searching} />
        </>
      )}
    </div>
  );
}
