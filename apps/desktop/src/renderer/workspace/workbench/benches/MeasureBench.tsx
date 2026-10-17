/**
 * The Measure workbench (stage island D12, D13, D16, D18, D19): search, Favourites and recent,
 * every measuring tool by family, Site data, Drawing aids, Templates, and "Saved in this project".
 * While a tool is live it morphs in place: the live card on top (the reading, the points, Undo,
 * Stop and Save with their keys) and the catalogue shrinks to a strip of tool buttons.
 * How the sidebar follows the tools is `workbench/measureFollow.ts`.
 */
import type { EngineStage } from '@aio/engine';
import { unitLabel } from '@aio/geo';
import type { SitePoint } from '@aio/schema';
import {
  bookmarks,
  industryTemplates,
  isTelecomTool,
  MIN_POINTS,
  parseBearing,
  templateLibrary,
  TOOL_FAMILY,
  TOOL_LABELS,
  type SnapSource,
} from '@aio/survey';
import { ariaKeys, Button, EmptyState, Icon, IconButton, Row, shortcutHint, useT } from '@aio/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShell } from '../../../shell';
import { BulkTotals } from '../../../survey/BulkTotals';
import { openCompareDialog } from '../../../survey/compareStore';
import { DesignsTool } from '../../../survey/Designs';
import { ExportTool } from '../../../survey/ExportDialog';
import { HaulRoadTool } from '../../../survey/HaulRoad';
import { HydroTool } from '../../../survey/Hydro';
import { MagicPolygon } from '../../../survey/MagicPolygon';
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
import { MeasurementList } from '../../../survey/MeasurementList';
import { MeasurementPanel } from '../../../survey/MeasurementPanel';
import {
  drawEvent,
  liveReading,
  measureStore,
  openDialog,
  setListOpen,
  setSnap,
  setSnapSource,
  startTool,
  stopTool,
  useMeasure,
} from '../../../survey/measureStore';
import { setOverlaysOpen, useOverlays } from '../../../survey/overlaysStore';
import { SurveyQaTool } from '../../../survey/Qa';
import {
  startTelecomTool,
  TelecomTools,
  useTelecomUnavailable,
} from '../../../survey/TelecomTools';
import { Tool, useEngineStage } from '../../StageTools';
import { SectionPanel, toggleMeasure, toggleSection } from '../../tools/measure';
import { Section } from '../Section';
import { filterSections, sectionStore, useSections } from '../sectionState';
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

const coord = (v: number) => v.toFixed(2);

/** The live tool on top of the bench: its reading, its points and Undo, Stop and Save (D13). */
function LiveCard() {
  const t = useT();
  const tool = useMeasure((s) => s.tool);
  const draw = useMeasure((s) => s.draw);
  const reading = useMeasure(liveReading);
  const units = useMeasure((s) => s.settings.units);
  if (!tool || !draw) return null;
  // the telecom tools keep their own card: what to pick, the picks so far and the reading
  if (isTelecomTool(tool.tool)) {
    return (
      <div className="meb-live">
        <TelecomTools />
      </div>
    );
  }
  const family = TOOL_FAMILY[tool.tool];
  const bearing = parseBearing(draw.typing.bearing);
  const env = { distanceUnit: units.distance };
  const n = draw.points.length;
  const points: SitePoint[] = draw.points.slice(-4);
  const enough = n >= MIN_POINTS[family];
  return (
    <section
      className="meb-live"
      aria-label={t('measureBench.live', { tool: tool.template?.name ?? TOOL_LABELS[tool.tool] })}
      data-testid="survey-drawbar"
    >
      <header className="meb-live-head">
        <b>{tool.template?.name ?? TOOL_LABELS[tool.tool]}</b>
        {tool.transient && <span className="meb-faint">{t('measureBench.notSaved')}</span>}
      </header>
      {tool.prompt && (
        <span className="meb-faint" role="status" data-testid="survey-draw-prompt">
          {tool.prompt}
        </span>
      )}
      <p className="meb-reading mono" data-testid="measure-reading">
        {reading ?? t('measureBench.noReading')}
      </p>
      <p className="meb-faint">
        {t('measureBench.points', { count: n })}
        {draw.lockedBearing !== null &&
          t('measureBench.locked', { deg: draw.lockedBearing.toFixed(1) })}
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
            {bearing !== null ? '°' : ''}
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

const SNAP_SOURCES: { source: SnapSource; label: string }[] = [
  { source: 'measurement', label: 'Measurements' },
  { source: 'design', label: 'Designs' },
  { source: 'alignment', label: 'Alignments' },
  { source: 'guide', label: 'Guidelines' },
];

/** The site's designs, survey QA, terrain overlays, hydrology, haul road, export and totals. */
function SiteData() {
  const readOnly = useReadOnly();
  const overlaysOpen = useOverlays((s) => s.open);
  return (
    <div className="meb-site">
      <div className="tgroup-h sv-nested" role="group" aria-label="Site data">
        <DesignsTool />
        <SurveyQaTool />
        <Tool
          icon="raster"
          label="Terrain overlays"
          testId="survey-overlays-open"
          pressed={overlaysOpen}
          onClick={() => {
            setOverlaysOpen(!overlaysOpen);
          }}
        />
        <HydroTool />
        <HaulRoadTool />
        <ExportTool />
      </div>
      <div className="sv-tool-row">
        <button
          type="button"
          className="btn sm"
          data-testid="survey-materials-tool"
          onClick={() => {
            openCompareDialog('materials');
          }}
        >
          Materials
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="survey-site-open"
          onClick={() => {
            openCompareDialog('site');
          }}
        >
          Whole site cut and fill
        </button>
        {!readOnly && (
          <button
            type="button"
            className="btn sm"
            data-testid="survey-units-open"
            onClick={() => {
              openDialog({ kind: 'units', target: 'site' });
            }}
          >
            Units
          </button>
        )}
      </div>
    </div>
  );
}

/** Snapping, its sources and distance, and the typed aids. */
function DrawingAids() {
  const snap = useMeasure((s) => s.snap);
  return (
    <div className="pop-form meb-aids">
      <label className="pop-row">
        <span className="pop-grow">Snap to vertices</span>
        <input
          type="checkbox"
          checked={snap.vertices}
          onChange={(e) => {
            setSnap({ vertices: e.target.checked });
          }}
        />
      </label>
      <label className="pop-row">
        <span className="pop-grow">Snap to edges</span>
        <input
          type="checkbox"
          checked={snap.edges}
          onChange={(e) => {
            setSnap({ edges: e.target.checked });
          }}
        />
      </label>
      <div className="sv-chips" role="group" aria-label="Snap to">
        {SNAP_SOURCES.map((s) => (
          <label key={s.source} className="sv-chip">
            <input
              type="checkbox"
              checked={snap.sources[s.source]}
              onChange={(e) => {
                setSnapSource(s.source, e.target.checked);
              }}
            />
            {s.label}
          </label>
        ))}
      </div>
      <label className="pop-row">
        <span>Snap distance</span>
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
      <p className="pop-note">
        Hold <span className="kbd">Shift</span> to lock the angle; type a distance and press{' '}
        <span className="kbd">Enter</span>; <span className="kbd">Tab</span> types a bearing;{' '}
        <span className="kbd">Esc</span> cancels.
      </p>
    </div>
  );
}

/** The bookmarked templates (each starts its tool) and the template editor. */
function Templates() {
  const active = useMeasure((s) => s.tool);
  const templates = useMeasure((s) => s.templates);
  const sets = useMeasure((s) => s.settings.templateSets);
  const lib = useMemo(
    () => bookmarks(templateLibrary(templates.project, templates.user, industryTemplates(sets))),
    [templates, sets],
  );
  return (
    <div className="meb-templates">
      {lib.length > 0 && (
        <ul className="meb-list" aria-label="Bookmarked templates">
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
      <button
        type="button"
        className="btn sm"
        data-testid="survey-templates-open"
        onClick={() => {
          openDialog({ kind: 'templates', edit: null, scope: 'project' });
        }}
      >
        <Icon name="flag" size={12} /> Templates
      </button>
    </div>
  );
}

/** The search, Favourites and recent, the families, Site data, Drawing aids and Templates. */
function Catalogue({
  families,
  stage,
}: {
  families: readonly Family[];
  stage: EngineStage | null;
}) {
  const t = useT();
  const readOnly = useReadOnly();
  const [query, setQuery] = useState('');
  const favourites = useFavourites((s) => s.favourites);
  const recent = useFavourites((s) => s.recent);
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
  const found = query.trim()
    ? filterSections(
        families.map((f) => ({ id: f.id, items: f.tools })),
        (e) => matchesQuery(e, query),
      )
    : null;
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
          setQuery(e.target.value);
        }}
      />
      {readOnly && (
        <p className="pop-note" data-testid="survey-tools-readonly">
          {t('measureBench.readOnly')}
        </p>
      )}
      {found?.length === 0 && (
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
          <Section bench={BENCH} id="siteData" title={t('measureCat.family.siteData')}>
            <SiteData />
          </Section>
          <Section bench={BENCH} id="aids" title={t('measureCat.family.aids')}>
            <DrawingAids />
          </Section>
          {!readOnly && (
            <Section bench={BENCH} id="templates" title={t('measureCat.family.templates')}>
              <Templates />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/** The picked measurement's panel (a telecom one shows in its family instead). */
function SelectedCard() {
  const t = useT();
  const focusTool = useMeasure((s) => s.file.measurements.find((m) => m.id === s.focus)?.tool);
  if (!focusTool || isTelecomTool(focusTool)) return null;
  return (
    <Section bench={BENCH} id="selected" title={t('measureBench.selected')} defaultOpen>
      <div className="meb-selected" data-testid="survey-side">
        <MeasurementPanel />
      </div>
    </Section>
  );
}

/**
 * "Saved in this project" (the measurements list, D18). Its section is open exactly while the
 * list is wanted: opening the list (the telecom card's Measurements, a finished shape) opens it,
 * and its Close or its header folds it.
 */
function Saved({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const count = useMeasure((s) => s.file.measurements.length);
  const listOpen = useMeasure((s) => s.listOpen);
  const sections = useSections(BENCH);
  const open = sections.isOpen('measurements');
  const seen = useRef({ listOpen, open });
  useEffect(() => {
    const was = seen.current;
    seen.current = { listOpen, open };
    if (listOpen !== was.listOpen) {
      if (listOpen !== open) sectionStore.getState().toggle(BENCH, 'measurements', open);
    } else if (open !== was.open && open !== listOpen) setListOpen(open);
  }, [listOpen, open]);
  return (
    <Section bench={BENCH} id="measurements" title={t('wb.saved')} count={count}>
      <MeasurementList stage={stage} />
      <BulkTotals />
    </Section>
  );
}

/** The Measure workbench's body, under the sidebar's bench header. */
export function MeasureBench() {
  const stage = useEngineStage();
  const readOnly = useReadOnly();
  const live = useMeasure((s) => s.tool !== null && s.draw !== null);
  const families = useMemo(() => familiesFor(readOnly), [readOnly]);
  return (
    <div className="meb">
      {live ? <LiveCard /> : <SelectedCard />}
      {live ? (
        <Strip families={families} stage={stage} />
      ) : (
        <Catalogue families={families} stage={stage} />
      )}
      <Saved stage={stage} />
    </div>
  );
}
