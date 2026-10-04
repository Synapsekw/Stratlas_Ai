import type { Layer } from '@aio/schema';
import { CommandPalette, type IconName, type PaletteCommand } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo } from 'react';
import { legacyLayers } from '../legacy';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';
import { selectClip } from './Sidebar';

const LAYER_ICON: Record<Layer['kind'], IconName> = {
  mesh: 'scene',
  legacy: 'scene',
  pointcloud: 'cloud',
  basemap: 'map',
  raster: 'raster',
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
      action('close', 'Close project', 'x', s.closeProject);
    }
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
  }, [library, cloudAi, project, issues, hidden, playing]);

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
