import { pinDisplay } from '@aio/annotate';
import { COLOUR_MODES, pointcloudSettings } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import {
  CommandPalette,
  formatDate,
  t,
  type IconName,
  type PaletteCommand,
  shortcutHint,
} from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { actionAllowed, allowedActions } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { alignCamera } from '../builder/alignSession';
import { pickTileset } from '../builder/ImportTileset';
import { builder } from '../builder/state';
import { diagnostics } from '../diagnostics/state';
import { help } from '../help/store';
import { legacyLayers } from '../legacy';
import { openModelBuilder } from '../modeller/ModellerLayer';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';
import { PATH_MODES, setPathMode, togglePaths } from '../workspace/flightPaths';
import { updateFlightPaths } from '../workspace/pathModel';
import { toggleTelemetry } from '../workspace/telemetryPref';
import { timeline, useTimeline } from '../workspace/timeline';
import { toggleTimeline } from '../workspace/timelinePref';
import { panelHandleLabel } from './PanelHandle';
import { selectClip } from './Sidebar';

const LAYER_ICON: Record<Layer['kind'], IconName> = {
  mesh: 'scene',
  legacy: 'scene',
  pointcloud: 'cloud',
  basemap: 'map',
  raster: 'raster',
  vector: 'map',
  video: 'video',
  photos: 'photo',
  panoramas: 'pano',
};

const LAYER_KIND: Record<Layer['kind'], string> = {
  mesh: 'Model',
  legacy: 'Original review',
  pointcloud: 'Point cloud',
  basemap: 'Basemap',
  raster: 'Raster',
  vector: 'Map overlay',
  video: 'Video',
  photos: 'Photos',
  panoramas: 'Panoramas',
};

const SCREENS: { screen: Screen; title: string; icon: IconName }[] = [
  { screen: 'projects', title: 'Projects', icon: 'projects' },
  { screen: 'scene', title: 'Scene', icon: 'scene' },
  { screen: 'issues', title: 'Issues', icon: 'issues' },
  { screen: 'media', title: 'Media', icon: 'media' },
  { screen: 'detections', title: t('nav.detections'), icon: 'target' },
  { screen: 'reports', title: 'Reports', icon: 'report' },
  { screen: 'jobs', title: 'Jobs', icon: 'clock' },
  { screen: 'settings', title: 'Settings', icon: 'settings' },
];

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
  const leftCollapsed = useShell((s) => s.settings.sidebarCollapsed);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const surveys = useTimeline((s) => s.index);

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
    const action = (id: string, title: string, icon: IconName, run: () => void, hint?: string) => {
      list.push({ id, title, group: 'Actions', icon, run, ...(hint ? { hint } : {}) });
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
    // the same words as the tab on the panel's edge: what the command does next
    list.push({
      id: 'sidebar',
      title: t(panelHandleLabel('left', leftCollapsed)),
      group: 'Actions',
      icon: 'sidebar',
      keywords: ['toggle sidebar', 'hide sidebar', 'show sidebar', 'fold', 'navigation'],
      hint: shortcutHint('global.sidebar'),
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
    if (legacyLayers(project?.manifest).length > 0) {
      list.push({
        id: 'go:review',
        title: 'Open the original review',
        group: 'Navigate',
        icon: 'history',
        keywords: ['legacy', 'viewer', 'original', 'snapshot'],
        run: () => {
          s.go('review');
        },
      });
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
      );
      action(
        'mode:map',
        'Show map',
        'map',
        scene(() => {
          s.setStageMode('map');
        }),
      );
      action(
        'mode:split',
        'Show 3D and map side by side',
        'split',
        scene(() => {
          s.setStageMode('split');
        }),
      );
      list.push({
        id: 'right',
        title: t(panelHandleLabel('right', rightCollapsed)),
        group: 'Actions',
        icon: 'sidebar',
        keywords: ['toggle right panel', 'hide right panel', 'show right panel', 'fold', 'agent'],
        hint: shortcutHint('global.rightPanel'),
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
        'Space',
      );
      action(
        'home',
        'Fly to the whole site',
        'target',
        scene(() => {
          ws.flyTo({ kind: 'home' });
        }),
      );
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
      const layers = project.manifest.layers;
      action(
        'pins',
        t('stage.pins.toggle'),
        'pin',
        scene(() => {
          pinDisplay.getState().togglePins();
        }),
        'I',
      );
      action(
        'timeline',
        t('timeline.toggle'),
        'clock',
        scene(() => {
          toggleTimeline(project);
        }),
        'T',
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
          'P',
        );
        action(
          'telemetry',
          t('stage.telemetry.toggle'),
          'telemetry',
          scene(() => {
            toggleTelemetry();
          }),
          'D',
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
          keywords: ['photos', 'video', 'srt', 'glb', 'obj', 'geotiff', 'las', 'laz', 'add data'],
          run: () => void builder.getState().pickAndImport(),
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
        const meshes = layers.filter((l) => l.kind === 'mesh');
        if (meshes[0]) {
          const first = meshes[0];
          list.push({
            id: 'builder:align-mesh',
            title: 'Georeference a model by point pairs',
            group: 'Actions',
            icon: 'target',
            keywords: ['align', 'gcp', 'control points', 'place model', 'transform'],
            run: () => {
              builder.getState().startAlign({ kind: 'mesh', layerId: first.id });
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
      if (l.kind === 'legacy') {
        list.push({
          id: `layer:${l.id}`,
          title: l.name,
          group: 'Layers',
          icon: 'history',
          keywords: [LAYER_KIND[l.kind]],
          hint: 'Original review',
          run: () => {
            s.go('review');
          },
        });
        continue;
      }
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
    return list;
  }, [
    library,
    cloudAi,
    offlineOnly,
    project,
    pkg,
    issues,
    hidden,
    playing,
    surveys,
    leftCollapsed,
    rightCollapsed,
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
