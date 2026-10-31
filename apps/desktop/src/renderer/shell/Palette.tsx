import { pinDisplay, useAnnotateReadOnly } from '@aio/annotate';
import { getActiveStage } from '@aio/engine';
import { COLOUR_MODES, pointcloudSettings } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import {
  CommandPalette,
  formatDate,
  getLocale,
  t,
  useT,
  type IconName,
  type MessageKey,
  type PaletteCommand,
  type ShortcutId,
  shortcutHint,
} from '@aio/ui';
import { isTelecomTool } from '@aio/survey';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { actionAllowed, allowedActions } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { alignCamera } from '../builder/alignSession';
import { pickTileset } from '../builder/ImportTileset';
import { builder } from '../builder/state';
import { createEngineeringModel, ENGINEERING_SOURCES, engineeringUiOn } from '../engineer/ui';
import { diagnostics } from '../diagnostics/state';
import { help } from '../help/store';
import { openModelBuilder } from '../modeller/ModellerLayer';
import { processing } from '../processing/store';
import { pickAndScanPanos } from '../panos/panos';
import { openProcessingTools } from '../processingTools';
import { shell, useShell } from '../shell';
import { layoutSpikeOn } from '../layoutSpike/flag';
import { isSidebarFolded, type Screen, type SettingsPage, type StageMode } from '../store';
import { TOOL_ICON } from '../survey/card';
import {
  ALL_TOOLS,
  favouritesAndRecent,
  familyOf,
  measureFavourites,
  useFavourites,
  type CatalogueTool,
} from '../survey/measureCatalogue';
import { measureStore, startTool, useMeasure } from '../survey/measureStore';
import { startTelecomTool, useTelecomUnavailable } from '../survey/TelecomTools';
import { GROUP_ICON, GROUP_NAME } from '../workspace/island/groups';
import { GROUP_TAB, openBenchFromIsland } from '../workspace/island/islandBench';
import { islandGroups } from '../workspace/island/islandModel';
import { useRoad } from '../road/store';
import { useEngineStage } from '../workspace/StageTools';
import { toggleMeasure, toggleSection } from '../workspace/tools/measure';
import { showBench } from '../workspace/workbench/followTool';
import { useHasVolumeMeasurements, useWorkbenchView } from '../workspace/workbench/view';
import { paletteIndex, type PaletteTool } from './paletteIndex';
import './palette.css';
import { PATH_MODES, setPathMode, togglePaths } from '../workspace/flightPaths';
import { updateFlightPaths } from '../workspace/pathModel';
import { useMapViewMenuModel } from '../workspace/MapMenus';
import { onlineSatelliteSwitch, pickBase } from '../workspace/onlineSatellite';
import { rasterPacks } from '../workspace/siteTiles';
import { toggleTelemetry } from '../workspace/telemetryPref';
import { timeline, useTimeline } from '../workspace/timeline';
import { hasTimeline, toggleTimeline } from '../workspace/timelinePref';
import { farNotice } from '../builder/farSession';
import { addDateMenu } from './AddSurveyDate';
import { panelHandleLabel } from './PanelHandle';
import { selectClip } from '../workspace/pickClip';
import { canAutoplan as canAutoplanCoverage, startAutoplan } from '../rf/autoplan/autoplanStore';
import { useChipState } from '../rf/CoverageChip';
import { openCoverage } from '../rf/rfTab';
import { useRf } from '../rf/rfStore';

/** The layer kinds the palette lists: a retired viewer of an older project is not offered. */
type ListedKind = Exclude<Layer['kind'], 'legacy'>;

const LAYER_ICON: Record<ListedKind, IconName> = {
  mesh: 'scene',
  pointcloud: 'cloud',
  basemap: 'map',
  raster: 'raster',
  vector: 'map',
  video: 'video',
  walk: 'pano',
  photos: 'photo',
  panoramas: 'pano',
};

const LAYER_KIND: Record<ListedKind, string> = {
  mesh: 'Model',
  pointcloud: 'Point cloud',
  basemap: 'Basemap',
  raster: 'Raster',
  vector: 'Map overlay',
  video: 'Video',
  walk: '360 walk',
  photos: 'Photos',
  panoramas: 'Panoramas',
};

const SCREENS: { screen: Screen; title: string; icon: IconName }[] = [
  { screen: 'projects', title: 'Projects', icon: 'projects' },
  { screen: 'scene', title: 'Scene', icon: 'scene' },
  { screen: 'issues', title: 'Issues', icon: 'issues' },
  { screen: 'inspect', title: t('nav.inspect'), icon: 'media' },
  { screen: 'reports', title: 'Reports', icon: 'report' },
  { screen: 'settings', title: 'Settings', icon: 'settings' },
];

/** The island's key for a stage view (1, 2, 3). */
const MODE_KEY: Record<StageMode, ShortcutId> = {
  '3d': 'scene.mode3d',
  map: 'scene.modeMap',
  split: 'scene.modeSplit',
};
const modeKey = (mode: StageMode): string => shortcutHint(MODE_KEY[mode]);

// ---------------------------------------------------------------- Settings pages
// The Settings pages by name, in the order of the Settings screen's list. One block: when the
// Settings pages move to their own module this becomes that module's list.
const SETTINGS_PAGE_LABEL: Record<SettingsPage, MessageKey> = {
  ai: 'settings.page.ai',
  'local-model': 'settings.page.localModel',
  models: 'settings.page.models',
  usage: 'settings.page.usage',
  privacy: 'settings.page.privacy',
  identity: 'identity.page',
  data: 'settings.page.data',
  tools: 'settings.page.tools',
  maps: 'settings.page.maps',
  'map-sources': 'settings.page.mapSources',
  datums: 'settings.page.datums',
  severity: 'settings.page.severity',
  classes: 'settings.page.classes',
  branding: 'settings.page.branding',
  graphics: 'settings.page.graphics',
  appearance: 'settings.page.appearance',
  keyboard: 'settings.page.keyboard',
  about: 'settings.page.about',
  // listed only while a project is open
  project: 'settings.page.project',
};

// ---------------------------------------------------------------- tools, island groups, tabs

/** Start a measuring tool from the palette: on the stage, and left on when it already is. */
function startCatalogueTool(tool: CatalogueTool): void {
  shell.getState().go('scene');
  const stage = getActiveStage();
  if (tool === 'section-plane') {
    measureFavourites.getState().used(tool);
    if (stage && !stage.section.enabled) toggleSection(stage);
    return;
  }
  const active = measureStore.getState().tool;
  if (active?.tool === tool && !active.template) return;
  if (tool === 'distance') toggleMeasure(stage);
  else if (isTelecomTool(tool)) startTelecomTool(tool);
  else {
    if (stage && stage.tool !== 'select') stage.setTool('select');
    startTool(tool);
  }
}

/**
 * The palette's tools, island groups, workbench tabs and Settings pages (`paletteIndex`), read
 * from what the stage and the right sidebar offer now. Tools, groups and tabs need an open project.
 */
function useIndexedCommands(): PaletteCommand[] {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg !== null);
  const stageMode = useShell((s) => s.stageMode);
  const readOnly = useMeasure((s) => s.readOnly) || pkg;
  const stage = useEngineStage();
  const telecomOff = useTelecomUnavailable();
  const favourites = useFavourites((s) => s.favourites);
  const recent = useFavourites((s) => s.recent);
  // the tabs the panel shows: a remembered tab that does not apply here is not offered
  const tabs = useWorkbenchView().tabs;
  // names are read in the language in use: a change of language builds the list again
  useT();
  const locale = getLocale();
  const kitVolumes = useVolumetric((x) => x.status === 'ready');
  const piles = useHasVolumeMeasurements();
  const road = useRoad((x) => x.status === 'ready');
  return useMemo(() => {
    const settingsPages = (Object.keys(SETTINGS_PAGE_LABEL) as SettingsPage[])
      .filter((id) => project !== null || id !== 'project')
      .map((id) => ({
        id,
        label: t(SETTINGS_PAGE_LABEL[id]),
        open: () => {
          shell.getState().openSettingsPage(id);
        },
      }));
    if (!project) return paletteIndex({ tools: [], groups: [], tabs: [], settingsPages });
    const onStage = (fn: () => void) => () => {
      shell.getState().go('scene');
      fn();
    };
    const measure = t(GROUP_NAME.measure);
    const tools: PaletteTool[] = ALL_TOOLS.map((e) => {
      const reason =
        readOnly && e.saves
          ? t('palette.unavailable.readOnly')
          : e.tool === 'section-plane'
            ? stage
              ? null
              : t('palette.unavailable.needs3d')
            : isTelecomTool(e.tool)
              ? telecomOff
              : null;
      const family = familyOf(e.tool);
      return {
        id: e.tool,
        group: measure,
        label: e.label,
        icon: e.tool === 'section-plane' ? 'section' : TOOL_ICON[e.tool],
        ...(e.key ? { shortcutId: e.key } : {}),
        keywords: [e.hint, ...(family ? [t(`measureCat.family.${family}`)] : [])],
        available: reason === null ? true : { reason },
        start: () => {
          startCatalogueTool(e.tool);
        },
      };
    });
    const layers = project.manifest.layers;
    const groups = islandGroups({
      map: stageMode === 'map',
      mode: stageMode,
      clouds: layers.some((l) => l.kind === 'pointcloud'),
      volumes: kitVolumes || piles,
      video: layers.some((l) => l.kind === 'video'),
      road,
      pkg,
    }).flatMap((g) => {
      const tab = GROUP_TAB[g];
      // View has no workbench: its tiles are the whole group
      if (!tab) return [];
      return [
        {
          id: g,
          label: t(GROUP_NAME[g]),
          icon: GROUP_ICON[g],
          tab,
          open: onStage(() => {
            openBenchFromIsland(tab);
          }),
        },
      ];
    });
    return paletteIndex({
      tools,
      preferred: favouritesAndRecent({ favourites, recent }),
      groups,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        label: t(`wb.tab.${tab.id}`),
        open: onStage(() => {
          showBench(tab.id);
        }),
      })),
      settingsPages,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `locale`: the names are read in it
  }, [
    project,
    pkg,
    stageMode,
    readOnly,
    stage,
    telecomOff,
    favourites,
    recent,
    tabs,
    locale,
    kitVolumes,
    piles,
    road,
  ]);
}

export function Palette() {
  const open = useShell((s) => s.paletteOpen);
  const library = useShell((s) => s.library);
  const cloudAi = useShell((s) => s.settings.cloudAi);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const hidden = useWorkspace((s) => s.hidden);
  const playing = useWorkspace((s) => s.playing);
  const pkg = useShell((s) => s.pkg);
  const leftCollapsed = useShell(isSidebarFolded);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const surveys = useTimeline((s) => s.index);
  const lookOnly = useAnnotateReadOnly();
  // the map commands follow the Map menu of the Map view (packs, keys, online maps)
  const mapMenu = useMapViewMenuModel();
  // the Coverage chip's two ways in (spec F1), offered while the chip shows
  const chip = useChipState();
  const rfReadOnly = useRf((r) => r.readOnly);
  const coverageShown = chip.kind !== 'hidden';
  // Auto-plan where the chip offers it or Re-plan: not before a review, nor while planning or
  // running, nor on a read-only project
  const canAutoplan = canAutoplanCoverage(chip, rfReadOnly);
  const hasProject = project !== null;
  const indexed = useIndexedCommands();
  useEffect(() => {
    if (open && hasProject) rasterPacks.getState().refresh();
  }, [open, hasProject]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const s = shell.getState();
    const ws = workspace.getState();
    const list: PaletteCommand[] = [];
    for (const sc of SCREENS) {
      list.push({
        id: `go:${sc.screen}`,
        title: `Go to ${sc.title}`,
        group: 'Navigate',
        icon: sc.icon,
        run: () => {
          s.go(sc.screen);
        },
      });
    }
    // where the processing tools (the pipeline pack) are installed and updated
    list.push({
      id: 'go:processing-tools',
      title: 'Processing tools (Settings)',
      group: 'Navigate',
      icon: 'download',
      keywords: ['pipeline pack', 'update', 'install', 'tools', 'python', 'jobs'],
      run: openProcessingTools,
    });
    // the open project's processing (the title bar chip opens the same drawer)
    list.push({
      id: 'open:processing',
      title: t('processing.title'),
      group: 'Navigate',
      icon: 'clock',
      keywords: ['jobs', 'running', 'progress', 'log', 'maps from photos'],
      run: () => {
        processing.getState().openDrawer();
      },
    });
    // the last argument is the key that does the same, shown at the row's end
    const action = (
      id: string,
      title: string,
      icon: IconName,
      run: () => void,
      shortcut?: string,
    ) => {
      list.push({ id, title, group: 'Actions', icon, run, ...(shortcut ? { shortcut } : {}) });
    };
    action(
      'help',
      t('help.open'),
      'search',
      () => {
        help.getState().openHelp();
      },
      shortcutHint('global.help'),
    );
    // the same words as the tab on the panel's edge: what the command does next (not in the
    // layout spike, which has no sidebar to fold)
    if (!layoutSpikeOn())
      list.push({
        id: 'sidebar',
        title: t(panelHandleLabel('left', leftCollapsed)),
        group: 'Actions',
        icon: 'sidebar',
        keywords: ['toggle sidebar', 'hide sidebar', 'show sidebar', 'fold', 'navigation'],
        shortcut: shortcutHint('global.sidebar'),
        run: () => void s.toggleSidebar(),
      });
    action('add-folder', 'Add project folder', 'import', () => void s.addProjectFolder());
    action('open-package', 'Open a project package (.aio)', 'lock', () => void s.openPackageFile());
    action('report-problem', t('diag.report'), 'bell', () => {
      diagnostics.getState().openProblem();
    });
    if (project && !pkg) {
      action('export-package', 'Export project package', 'download', () => {
        s.setExportFor(project.id);
      });
    }
    // the title bar's connection switch (Settings, Privacy and cloud: Offline-only workstation)
    list.push({
      id: 'connection',
      title: t(offlineOnly ? 'connection.goOnline' : 'connection.workOffline'),
      group: 'Actions',
      icon: offlineOnly ? 'globe' : 'offline',
      keywords: ['connection', 'network', 'internet', 'online', 'offline', 'download maps'],
      run: () => void s.updateSettings({ offlineOnly: !offlineOnly }),
    });
    if (offlineOnly) {
      // the switch would change nothing while the workstation is offline-only: say so instead
      action('cloud', 'Cloud AI is off: this workstation is offline-only', 'agent', () => {
        s.go('settings');
      });
    } else {
      action(
        'cloud',
        cloudAi ? 'Turn cloud AI off' : 'Turn cloud AI on',
        'agent',
        () => void s.updateSettings({ cloudAi: !cloudAi }),
      );
    }
    if (project) {
      const scene = (fn: () => void) => () => {
        s.go('scene');
        fn();
      };
      action('model-builder', 'Open the model builder', 'plant', openModelBuilder);
      action(
        'mode:3d',
        'Show 3D view',
        'scene',
        scene(() => {
          s.setStageMode('3d');
        }),
        modeKey('3d'),
      );
      action(
        'mode:map',
        'Show map',
        'map',
        scene(() => {
          s.setStageMode('map');
        }),
        modeKey('map'),
      );
      action(
        'mode:split',
        'Show 3D and map side by side',
        'split',
        scene(() => {
          s.setStageMode('split');
        }),
        modeKey('split'),
      );
      list.push({
        id: 'right',
        title: t(panelHandleLabel('right', rightCollapsed)),
        group: 'Actions',
        icon: 'sidebar',
        keywords: ['toggle right panel', 'hide right panel', 'show right panel', 'fold', 'agent'],
        shortcut: shortcutHint('global.rightPanel'),
        run: s.toggleRight,
      });
      action(
        'play',
        playing ? 'Pause' : 'Play',
        playing ? 'pause' : 'play',
        () => {
          if (playing) ws.pause();
          else ws.play();
        },
        shortcutHint('global.playPause'),
      );
      action(
        'home',
        'Fly to the whole site',
        'target',
        scene(() => {
          ws.flyTo({ kind: 'home' });
        }),
      );
      action(
        'site',
        'Centre on project',
        'crosshair',
        scene(() => {
          ws.flyTo({ kind: 'site' });
        }),
      );
      // the review dialog lives in the Coverage tab: it opens too
      if (canAutoplan)
        action(
          'rf:autoplan',
          t('rf.chip.paletteAutoplan'),
          'agent',
          scene(() => {
            openCoverage();
            void startAutoplan();
          }),
        );
      if (coverageShown) action('rf:open', t('rf.chip.paletteOpen'), 'layers', scene(openCoverage));
      // the base maps, as the Map menu on the map offers them (a greyed one is not listed)
      const onMap = (fn: () => void) =>
        scene(() => {
          if (shell.getState().stageMode === '3d') s.setStageMode('map');
          fn();
        });
      for (const tile of mapMenu.sections.flatMap((sec) => sec.tiles)) {
        if (tile.state !== 'available') continue;
        list.push({
          id: `map:base:${tile.id}`,
          title: t('palette.mapBase', { name: t(tile.name) }),
          group: 'Actions',
          icon: 'map',
          keywords: ['basemap', 'map type', 'imagery', 'aerial', 'streets', 'satellite', tile.id],
          ...(mapMenu.chosen === tile.id ? { hint: t('palette.basemap.current') } : {}),
          run: onMap(() => {
            pickBase(tile.id, (b) => {
              rasterPacks.getState().set({ mapBase: b });
            });
            // a first use of a provider asks first, in Settings, where the notice says what is sent
            if (onlineSatelliteSwitch.getState().asking) s.openSettingsPage('map-sources');
          }),
        });
      }
      const shade = mapMenu.onTop.find((r) => r.key === 'hillshade');
      if (shade && !shade.disabled)
        list.push({
          id: 'basemap:hillshade',
          title: t(shade.on ? 'palette.hillshade.off' : 'palette.hillshade.on'),
          group: 'Actions',
          icon: 'map',
          keywords: ['hillshade', 'relief', 'terrain', 'map type'],
          run: onMap(() => {
            rasterPacks.getState().set({ hillshade: !shade.on });
          }),
        });
      // online maps: the same switch as Settings, Map sources, not offered offline only. The
      // first time it asks first, in Settings, where the notice says what is requested.
      const onlineOn = rasterPacks.getState().prefs.onlineSatellite;
      if (!offlineOnly)
        list.push({
          id: 'basemap:online',
          title: t(onlineOn ? 'palette.online.off' : 'palette.online.on'),
          group: 'Actions',
          icon: 'globe',
          keywords: ['satellite', 'sentinel', 'imagery', 'online', 'map type', 'basemap'],
          run: () => {
            onlineSatelliteSwitch.getState().request(!rasterPacks.getState().prefs.onlineSatellite);
            if (onlineSatelliteSwitch.getState().asking) s.openSettingsPage('map-sources');
          },
        });
      if (!pkg)
        list.push({
          id: 'basemap:packs',
          title: t('palette.basemap.packs'),
          group: 'Actions',
          icon: 'import',
          keywords: ['satellite', 'imagery', 'terrain', 'basemap', 'offline maps', 'packs'],
          run: () => {
            s.openSettings('raster-packs');
          },
        });
      const tl = timeline.getState();
      if (surveys && surveys.captures.length > 1) {
        action(
          'survey-prev',
          t('palette.prevSurvey'),
          'history',
          scene(() => {
            tl.step(-1);
          }),
          shortcutHint('global.prevSurvey'),
        );
        action(
          'survey-next',
          t('palette.nextSurvey'),
          'history',
          scene(() => {
            tl.step(1);
          }),
          shortcutHint('global.nextSurvey'),
        );
      }
      for (const c of surveys?.captures ?? []) {
        action(
          `survey-${c.id}`,
          t('palette.surveyOn', { date: formatDate(c.date) }),
          'history',
          scene(() => {
            tl.focusSurvey(c.id);
          }),
        );
      }
      if (!pkg && !lookOnly) {
        list.push({
          id: 'add-survey-date',
          title: t('palette.addSurveyDate'),
          group: 'Actions',
          icon: 'history',
          keywords: ['survey', 'date', 'new date', 'capture', 'timeline'],
          run: () => {
            if (isSidebarFolded(shell.getState())) void shell.getState().toggleSidebar();
            addDateMenu.getState().set(true);
          },
        });
        list.push({
          id: 'import-flight-folder',
          title: t('palette.importFlightFolder'),
          group: 'Actions',
          icon: 'import',
          keywords: ['survey', 'date', 'flight', 'folder', 'import', 'drone', 'photos', 'video'],
          run: () => {
            void builder.getState().pickAndImportFolder();
          },
        });
      }
      const layers = project.manifest.layers;
      action(
        'pins',
        t('stage.pins.toggle'),
        'pin',
        scene(() => {
          pinDisplay.getState().togglePins();
        }),
        shortcutHint('scene.pins'),
      );
      // no video and one survey date: no timeline to show (the View tile says why)
      if (hasTimeline(project))
        action(
          'timeline',
          t('timeline.toggle'),
          'clock',
          scene(() => {
            toggleTimeline(project);
          }),
        );
      const clouds = layers.filter((l) => l.kind === 'pointcloud');
      if (clouds.length > 0) {
        const rgb = clouds.some((l) => l.format === 'png-packed');
        for (const m of COLOUR_MODES) {
          if (m.id === 'rgb' && !rgb) continue;
          list.push({
            id: `cloud-colour:${m.id}`,
            title: `Colour point cloud by ${m.id === 'rgb' ? 'RGB' : m.label.toLowerCase()}`,
            group: 'Actions',
            icon: 'cloud',
            keywords: ['colour', 'color', 'colorize', 'colorization', 'point cloud', m.hint],
            hint: 'Point cloud',
            run: scene(() => {
              pointcloudSettings.getState().setColourMode(m.id);
              // a hidden cloud would show nothing: bring it in
              if (clouds.every((l) => hidden[l.id]))
                for (const l of clouds) ws.setLayerVisible(l.id, true);
            }),
          });
        }
        list.push({
          id: 'cloud-panel',
          title: 'Point cloud display: colour, size, budget',
          group: 'Actions',
          icon: 'cloud',
          keywords: ['colour', 'color', 'elevation', 'eye-dome', 'EDL', 'points'],
          run: () => {
            s.openCloudPanel();
          },
        });
      }
      if (layers.some((l) => l.kind === 'video')) {
        action(
          'paths',
          'Turn flight paths off or on',
          'path',
          scene(() => {
            updateFlightPaths(togglePaths);
          }),
          shortcutHint('scene.flightPaths'),
        );
        action(
          'telemetry',
          t('stage.telemetry.toggle'),
          'telemetry',
          scene(() => {
            toggleTelemetry();
          }),
          shortcutHint('scene.telemetry'),
        );
        for (const m of PATH_MODES)
          list.push({
            id: `paths:${m.mode}`,
            title: `Flight paths: ${m.label.toLowerCase()}`,
            group: 'Actions',
            icon: 'path',
            keywords: ['flight path', 'track', 'trajectory', m.hint],
            run: scene(() => {
              updateFlightPaths((p) => setPathMode(p, m.mode));
            }),
          });
      }
      // a package offers only the exports its header allows
      for (const a of allowedActions(pkg)) {
        list.push({
          id: `export:${a.id}`,
          title: a.title,
          group: 'Export',
          icon: a.icon,
          hint: a.hint,
          keywords: ['export', 'save', 'download', a.label],
          run: () => {
            runExportAction(a.id, { legend: true });
          },
        });
      }
      if (actionAllowed('snapshot', pkg))
        list.push({
          id: 'export:snapshot-plain',
          title: 'Save a snapshot of the 3D view without legend',
          group: 'Export',
          icon: 'camera',
          keywords: ['export', 'screenshot', 'png', 'image'],
          run: () => {
            runExportAction('snapshot', { legend: false });
          },
        });
      // a package is read-only: no import, georeference or calibration
      if (!pkg) {
        list.push({
          id: 'builder:import',
          title: 'Import raw data into this project',
          group: 'Actions',
          icon: 'import',
          keywords: [
            'photos',
            'video',
            'srt',
            'glb',
            'obj',
            'geotiff',
            'las',
            'laz',
            'add data',
            'zpc',
            'bentley',
            'contextcapture',
            'xml',
          ],
          run: () => void builder.getState().pickAndImport(),
        });
        list.push({
          id: 'builder:add-drawing',
          title: 'Add a drawing to this project',
          group: 'Actions',
          icon: 'drawing',
          keywords: ['pdf', 'png', 'plan', 'sheet', 'scan', 'dxf', 'layout', 'drawings'],
          run: () => void builder.getState().pickAndAddDrawing(),
        });
        list.push({
          id: 'builder:import-360',
          title: 'Add 360 video',
          group: 'Actions',
          icon: 'pano',
          hint: 'A 360 camera file (.insv) or a stitched 360 video (MP4)',
          keywords: ['360', 'insta360', 'insv', 'lrv', 'equirectangular', 'walk', 'panorama'],
          run: () => void builder.getState().pickAndImport360(),
        });
        list.push({
          id: 'panos:add',
          title: t('pano.add'),
          group: 'Actions',
          icon: 'pano',
          hint: t('pano.add.tip'),
          keywords: ['pano', 'panorama', '360', 'sphere', 'drone', 'dji'],
          run: () => void pickAndScanPanos(),
        });
        list.push({
          id: 'builder:import-tiles',
          title: 'Import 3D Tiles from another program',
          group: 'Actions',
          icon: 'import',
          keywords: [
            '3d tiles',
            'tileset',
            'tileset.json',
            'bentley',
            'pix4d',
            'dji terra',
            'mesh',
          ],
          run: () => void pickTileset(),
        });
        list.push({
          id: 'builder:check-placement',
          title: 'Check where layers lie against the project origin',
          group: 'Actions',
          icon: 'target',
          keywords: ['origin', 're-centre', 'recenter', 'far', 'placement', 'out of view'],
          run: () => void farNotice.getState().check(ws.project?.id ?? '', 'all'),
        });
        const meshes = layers.filter((l) => l.kind === 'mesh');
        if (meshes[0]) {
          const first = meshes[0];
          list.push({
            id: 'builder:align-mesh',
            title: 'Georeference a model by point pairs',
            group: 'Actions',
            icon: 'target',
            keywords: [
              'align',
              'gcp',
              'control points',
              'place model',
              'transform',
              'up axis',
              'z up',
              'y up',
              'lying down',
            ],
            run: () => {
              builder.getState().startAlign({ kind: 'mesh', layerId: first.id });
            },
          });
          // the selected model (its layer, or a component of it), else the first
          const sel = ws.selection;
          const chosen =
            meshes.find((l) => sel && (l.id === sel.layer || l.id === sel.id)) ?? first;
          list.push({
            id: 'builder:place-model',
            title: t('place.palette'),
            group: 'Actions',
            icon: 'target',
            keywords: ['place', 'move', 'rotate', 'turn', 'tilt', 'scale', 'gizmo', 'position'],
            run: () => {
              builder.getState().startAlign({ kind: 'place', layerId: chosen.id });
            },
          });
        }
        if (engineeringUiOn()) {
          // the selected source layer (or the layer of a selected component) starts chosen
          const sel = ws.selection;
          const from = layers.find(
            (l) =>
              ENGINEERING_SOURCES.includes(l.kind) &&
              sel !== null &&
              (l.id === sel.id || l.id === sel.layer),
          );
          list.push({
            id: 'engineer:create',
            title: t('eng.entry.palette'),
            group: 'Actions',
            icon: 'box',
            keywords: ['engineering', 'chimney', 'flare', 'tower', 'stack', 'component', 'model'],
            run: () => {
              createEngineeringModel(from ? [from.id] : []);
            },
          });
        }
        const clip =
          layers.find((l) => l.kind === 'video' && l.id === ws.activeClip) ??
          layers.find((l) => l.kind === 'video');
        if (clip) {
          list.push({
            id: 'builder:calibrate-video',
            title: 'Calibrate video: time offset and field of view',
            group: 'Actions',
            icon: 'droneeye',
            keywords: ['align', 'lens', 'fov', 'offset', 'sync', 'calibration'],
            run: () => {
              builder.getState().startAlign({ kind: 'video', layerId: clip.id });
            },
          });
          list.push({
            id: 'builder:align-camera',
            title: 'Align camera to map: set where the video camera looks',
            group: 'Actions',
            icon: 'droneeye',
            keywords: ['camera direction', 'heading', 'yaw', 'keyframe', 'gimbal', 'orientation'],
            run: () => {
              alignCamera.getState().start(clip.id);
            },
          });
        }
      }
      action('close', 'Close project', 'x', s.closeProject);
    }
    list.push({
      id: 'builder:new',
      title: 'New project',
      group: 'Actions',
      icon: 'plus',
      keywords: ['create', 'wizard', 'builder', 'start'],
      run: () => {
        builder.getState().openWizard();
      },
    });
    for (const e of library ?? []) {
      list.push({
        id: `project:${e.id}`,
        title: e.name,
        group: 'Projects',
        icon: 'layers',
        keywords: [e.customer ?? '', e.site ?? ''].filter(Boolean),
        hint: e.customer ?? e.kind,
        run: () => void s.openProject(e.path),
      });
    }
    for (const l of project?.manifest.layers ?? []) {
      if (l.kind === 'legacy') continue;
      list.push({
        id: `layer:${l.id}`,
        title: l.name,
        group: 'Layers',
        icon: LAYER_ICON[l.kind],
        keywords: [LAYER_KIND[l.kind]],
        hint: `${LAYER_KIND[l.kind]}${hidden[l.id] ? ', hidden' : ''}`,
        run: () => {
          s.go('scene');
          if (l.kind === 'video') selectClip(l.id);
          else ws.select({ kind: 'layer', id: l.id, layer: l.id });
          if (hidden[l.id]) ws.setLayerVisible(l.id, true);
        },
      });
    }
    for (const i of issues) {
      list.push({
        id: `issue:${i.id}`,
        title: `${i.code}  ${i.title}`,
        group: 'Issues',
        icon: 'issues',
        keywords: [i.classId, i.status],
        hint: `${String(i.severity)} · ${i.status}`,
        run: () => {
          ws.select({ kind: 'issue', id: i.id });
          s.go('issues');
        },
      });
    }
    // the tools, island groups, tabs and Settings pages last: an empty search keeps its first rows
    list.push(...indexed);
    return list;
  }, [
    indexed,
    library,
    cloudAi,
    offlineOnly,
    project,
    pkg,
    lookOnly,
    issues,
    hidden,
    playing,
    surveys,
    leftCollapsed,
    rightCollapsed,
    mapMenu,
    coverageShown,
    canAutoplan,
  ]);

  if (!open) return null;
  return (
    <CommandPalette
      commands={commands}
      onClose={() => {
        shell.getState().setPalette(false);
      }}
    />
  );
}
