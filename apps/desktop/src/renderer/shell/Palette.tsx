import { COLOUR_MODES, pointcloudSettings } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import { CommandPalette, type IconName, type PaletteCommand } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { actionAllowed, allowedActions } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { builder } from '../builder/state';
import { legacyLayers } from '../legacy';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';
import { PATH_MODES, setPathMode, togglePaths } from '../workspace/flightPaths';
import { updateFlightPaths } from '../workspace/pathModel';
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
  { screen: 'reports', title: 'Reports', icon: 'report' },
  { screen: 'jobs', title: 'Jobs', icon: 'clock' },
  { screen: 'settings', title: 'Settings', icon: 'settings' },
];

export function Palette() {
  const open = useShell((s) => s.paletteOpen);
  const library = useShell((s) => s.library);
  const cloudAi = useShell((s) => s.settings.cloudAi);
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const hidden = useWorkspace((s) => s.hidden);
  const playing = useWorkspace((s) => s.playing);
  const pkg = useShell((s) => s.pkg);

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
    action('sidebar', 'Toggle sidebar', 'sidebar', () => void s.toggleSidebar(), 'Ctrl B');
    action('add-folder', 'Add project folder', 'import', () => void s.addProjectFolder());
    action('open-package', 'Open a project package (.aio)', 'lock', () => void s.openPackageFile());
    if (project && !pkg) {
      action('export-package', 'Export project package', 'download', () => {
        s.setExportFor(project.id);
      });
    }
    action(
      'cloud',
      cloudAi ? 'Turn cloud AI off' : 'Turn cloud AI on',
      'agent',
      () => void s.updateSettings({ cloudAi: !cloudAi }),
    );
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
      action('right', 'Toggle right panel', 'sidebar', s.toggleRight, 'Ctrl Alt B');
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
      const layers = project.manifest.layers;
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
  }, [library, cloudAi, project, pkg, issues, hidden, playing]);

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
